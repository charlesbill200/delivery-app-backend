// routes/payments.js
//
// Flow (matches the master prompt's required authority chain):
//   1. Customer app already created the order via POST /api/orders
//      (unchanged - that route remains the single source of truth for
//      pricing: items total + zone-aware delivery fee). The order is
//      created with payment_status = 'pending'.
//   2. POST /api/payments/initialize - takes an order_id, re-reads the
//      order's total_amount FROM THE DATABASE (never from the request
//      body), creates a payment row, asks Paystack for a checkout URL.
//   3. Customer completes payment on Paystack's hosted page.
//   4. Two independent confirmations, either can arrive first:
//      a) POST /api/payments/webhook - Paystack's server calling us.
//      b) GET /api/payments/verify/:reference - the app calling us when
//         the customer returns from the checkout page.
//      Both paths call the SAME verifyAndFinalize() function, which is
//      idempotent - whichever arrives first does the work, the second
//      is a no-op.
//
// The frontend is NEVER trusted to say "payment succeeded" - only a
// verified Paystack response (webhook signature or verify-API call)
// can move payment_status to 'success'.

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const db = require("../db");
const optionalCustomerAuth = require("../middleware/optionalCustomerAuth");
const paystack = require("../services/paystackService");

// Friendly, non-technical messages only - raw gateway errors never reach
// the customer (see PAYMENT FAILURE section of the spec).
const GENERIC_PAYMENT_ERROR =
  "We couldn't start your payment right now. Please try again in a moment.";

function generateReference(orderId) {
  // Prefixed + random, so it's obviously ours and can't collide across
  // orders even on rapid retries. Not guessable/sequential.
  return `qb_${orderId}_${crypto.randomBytes(8).toString("hex")}`;
}

// -----------------------------------------------------------------
// POST /api/payments/initialize
// Body: { order_id, email, callback_url }
// PUBLIC (guest or logged-in) - same auth shape as order creation itself.
// -----------------------------------------------------------------
router.post("/initialize", optionalCustomerAuth, async (req, res) => {
  const { order_id, email, callback_url } = req.body;

  if (!order_id || !email) {
    return res.status(400).json({ error: "order_id and email are required" });
  }

  try {
    // Re-read the order from the DB - amount is never accepted from the
    // client. Also confirms this order actually exists and belongs to
    // whoever's asking (customer_id match if logged in; guests can pay
    // for any order they created since guest orders have no owner to
    // check against - matches the existing guest-checkout model).
    const orderResult = await db.query(
      `SELECT id, customer_id, total_amount, payment_status, status
       FROM orders WHERE id = $1`,
      [order_id],
    );
    const order = orderResult.rows[0];

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    if (
      req.customerId &&
      order.customer_id &&
      order.customer_id !== req.customerId
    ) {
      return res
        .status(403)
        .json({ error: "This order does not belong to you" });
    }
    if (order.payment_status === "success") {
      return res
        .status(409)
        .json({ error: "This order has already been paid for" });
    }
    if (order.status === "cancelled") {
      return res.status(409).json({ error: "This order has been cancelled" });
    }

    const reference = generateReference(order.id);

    // Create the payment row BEFORE calling Paystack, status 'pending' -
    // if the Paystack call fails or the process crashes right after, we
    // still have a record of the attempt for support/troubleshooting,
    // and the unique constraint on `reference` means retries can never
    // create two payment rows for the same attempt.
    await db.query(
      `INSERT INTO payments (order_id, customer_id, reference, provider, amount, currency, status)
       VALUES ($1, $2, $3, 'paystack', $4, 'NGN', 'pending')`,
      [
        order.id,
        order.customer_id || req.customerId || null,
        reference,
        order.total_amount,
      ],
    );

    const paystackData = await paystack.initializeTransaction({
      email,
      amountNaira: parseFloat(order.total_amount),
      reference,
      callbackUrl: callback_url,
      metadata: { order_id: order.id },
    });

    // Only what the frontend needs to open the checkout page - never
    // the secret key, never internal payment row details.
    res.json({
      authorization_url: paystackData.authorization_url,
      access_code: paystackData.access_code,
      reference: paystackData.reference,
    });
  } catch (err) {
    console.error("Payment initialization failed:", err);
    res.status(err.statusCode || 500).json({ error: GENERIC_PAYMENT_ERROR });
  }
});

// -----------------------------------------------------------------
// Shared finalize logic - called from both the webhook and the
// customer-facing verify endpoint. Idempotent: if this reference has
// already been marked 'success', it just returns the existing row
// instead of re-processing.
// -----------------------------------------------------------------
async function verifyAndFinalize(reference) {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    // Lock the payment row for the duration of this transaction so a
    // webhook and a client-side verify call arriving at nearly the same
    // instant can't both "win" and double-process the same payment.
    const paymentResult = await client.query(
      `SELECT * FROM payments WHERE reference = $1 FOR UPDATE`,
      [reference],
    );
    const payment = paymentResult.rows[0];

    if (!payment) {
      await client.query("ROLLBACK");
      return { statusCode: 404, error: "Unknown payment reference" };
    }

    if (payment.status === "success") {
      // Already finalized - idempotent no-op, not an error.
      await client.query("ROLLBACK");
      return { statusCode: 200, payment, alreadyProcessed: true };
    }

    const verified = await paystack.verifyTransaction(reference);
    const paidAmountNaira = verified.amount / 100;

    // Cross-check EVERYTHING against what we recorded when we
    // initialized the payment - reference alone isn't enough, since a
    // tampered client could try to replay a valid reference against a
    // different (cheaper) order.
    const amountMatches =
      Math.abs(paidAmountNaira - parseFloat(payment.amount)) < 0.01;
    const currencyMatches = verified.currency === payment.currency;

    let newStatus;
    if (verified.status === "success" && amountMatches && currencyMatches) {
      newStatus = "success";
    } else if (verified.status === "success") {
      // Paystack says success but our own checks disagree - treat as
      // failed rather than trusting a mismatched amount/currency.
      newStatus = "failed";
    } else if (verified.status === "abandoned") {
      newStatus = "cancelled";
    } else {
      newStatus = "failed";
    }

    await client.query(
      `UPDATE payments SET
         status = $1,
         provider_ref = $2,
         gateway_response = $3,
         paid_at = CASE WHEN $1 = 'success' THEN NOW() ELSE paid_at END,
         updated_at = NOW()
       WHERE reference = $4`,
      [
        newStatus,
        String(verified.id || ""),
        verified.gateway_response || null,
        reference,
      ],
    );

    // Payment success promotes the order out of "pending_payment" into
    // the normal fulfillment lifecycle - this is the ONE place that
    // happens, and it only happens after a verified provider response,
    // never from anything the frontend claims. If the order is already
    // past "pending_payment" for some reason (e.g. this webhook is a
    // late/duplicate delivery arriving after a prior call already
    // advanced it), the CASE leaves the fulfillment status untouched -
    // this update only ever moves it forward, never backward.
    await client.query(
      `UPDATE orders SET
         payment_status = $1,
         payment_method = 'paystack',
         status = CASE
           WHEN $1 = 'success' AND status = 'pending_payment' THEN 'placed'
           ELSE status
         END
       WHERE id = $2`,
      [newStatus, payment.order_id],
    );

    await client.query("COMMIT");
    return { statusCode: 200, payment: { ...payment, status: newStatus } };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// -----------------------------------------------------------------
// GET /api/payments/verify/:reference
// Called by the app when the customer returns from the Paystack
// checkout page. This is a CONVENIENCE path for fast UI feedback -
// the webhook below is the durable source of truth and will also fire.
// -----------------------------------------------------------------
router.get("/verify/:reference", async (req, res) => {
  try {
    const result = await verifyAndFinalize(req.params.reference);
    if (result.error) {
      return res.status(result.statusCode).json({ error: result.error });
    }
    res.json({
      status: result.payment.status,
      order_id: result.payment.order_id,
    });
  } catch (err) {
    console.error("Payment verification failed:", err);
    res.status(500).json({
      error:
        "We couldn't confirm your payment status. Please check your order history shortly.",
    });
  }
});

// -----------------------------------------------------------------
// POST /api/payments/webhook
// Paystack calls this server-to-server. Must be mounted with
// express.raw() (see server.js) so the signature check runs against
// the exact bytes Paystack signed, not a re-serialized JSON object.
// -----------------------------------------------------------------
router.post("/webhook", async (req, res) => {
  const signature = req.headers["x-paystack-signature"];

  if (!paystack.verifyWebhookSignature(req.body, signature)) {
    // Do not process, do not leak WHY - just reject.
    return res.status(401).json({ error: "Invalid signature" });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch (err) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  // Acknowledge immediately-ish, but only after finalizing, so Paystack
  // doesn't get a false 200 before we've actually recorded anything.
  // Paystack retries on non-2xx, which is fine - verifyAndFinalize is
  // idempotent.
  try {
    if (event.event === "charge.success" || event.event === "charge.failed") {
      const reference = event.data?.reference;
      if (reference) {
        await verifyAndFinalize(reference);
      }
    }
    // Any other event type: acknowledge and ignore - we don't currently
    // act on refunds/transfers etc.
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook processing failed:", err);
    // 500 so Paystack retries later instead of us silently dropping it.
    res.sendStatus(500);
  }
});

module.exports = router;
