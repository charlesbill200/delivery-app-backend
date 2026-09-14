// services/paystackService.js
// All direct communication with Paystack lives here, so routes/payments.js
// never touches fetch/axios or the secret key directly.
//
// Required env vars (see .env.example):
//   PAYSTACK_SECRET_KEY   - starts with sk_test_ or sk_live_
//   PAYSTACK_PUBLIC_KEY   - starts with pk_test_ or pk_live_ (frontend-safe)
//   PAYSTACK_WEBHOOK_SECRET - only needed if Paystack gives you a distinct
//                             webhook secret; otherwise this equals the
//                             secret key (Paystack signs webhooks with the
//                             secret key by default - see verifyWebhookSignature)

const crypto = require("crypto");

const PAYSTACK_BASE_URL = "https://api.paystack.co";
const SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

if (!SECRET_KEY) {
  // Loud failure at boot, not a silent 500 on the customer's first checkout.
  console.warn(
    "⚠️  PAYSTACK_SECRET_KEY is not set - payment routes will fail until it's configured.",
  );
}

async function paystackRequest(path, { method = "GET", body } = {}) {
  const response = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json();

  if (!response.ok || data.status === false) {
    const err = new Error(data.message || "Payment provider request failed");
    err.paystackResponse = data;
    err.statusCode = response.status >= 400 ? response.status : 502;
    throw err;
  }

  return data;
}

// Amount is in Naira (matches orders.total_amount) - Paystack expects kobo,
// so this is the ONE place that multiplies by 100. Never do that math
// anywhere else in the codebase.
async function initializeTransaction({
  email,
  amountNaira,
  reference,
  callbackUrl,
  metadata,
}) {
  const data = await paystackRequest("/transaction/initialize", {
    method: "POST",
    body: {
      email,
      amount: Math.round(amountNaira * 100),
      reference,
      callback_url: callbackUrl,
      metadata,
    },
  });
  // { authorization_url, access_code, reference }
  return data.data;
}

async function verifyTransaction(reference) {
  const data = await paystackRequest(
    `/transaction/verify/${encodeURIComponent(reference)}`,
  );
  // { status: 'success'|'failed'|..., amount (kobo), currency, reference, ... }
  return data.data;
}

// Paystack signs webhook payloads with an HMAC-SHA512 of the RAW request
// body, using the secret key. This must be computed against the raw
// (unparsed) body - see the express.raw() middleware in routes/payments.js.
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const hash = crypto
    .createHmac("sha512", SECRET_KEY)
    .update(rawBody)
    .digest("hex");
  return hash === signatureHeader;
}

module.exports = {
  initializeTransaction,
  verifyTransaction,
  verifyWebhookSignature,
};
