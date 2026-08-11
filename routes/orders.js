// routes/orders.js
// Defines what happens when the frontend hits /api/orders
//
// NOTE: unlike menu items, not every route here needs a login -
// customers placing an order aren't necessarily logged-in. Only the
// vendor-facing routes (viewing orders, updating status) require login.
// POST uses optionalCustomerAuth so a logged-in customer's order gets
// linked to their account, but guest checkout still works too.

const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const optionalCustomerAuth = require("../middleware/optionalCustomerAuth");

const VALID_STATUSES = [
  "placed",
  "accepted",
  "preparing",
  "ready",
  "picked_up",
  "delivered",
  "cancelled",
];

// -----------------------------------------
// POST /api/orders  (PUBLIC - called by the Customer App, guest or logged-in)
// Creates a new order with one or more items, plus the correct delivery
// fee for the given zone (falls back to the vendor's flat fee if the
// customer has no zone, or the vendor hasn't set one for that zone).
// -----------------------------------------
router.post("/", optionalCustomerAuth, async (req, res) => {
  const {
    vendor_id,
    customer_name,
    customer_phone,
    delivery_address,
    zone_id,
    items,
  } = req.body;

  if (!items || items.length === 0) {
    return res
      .status(400)
      .json({ error: "An order must include at least one item" });
  }

  const client = await db.getClient();

  try {
    await client.query("BEGIN");

    const itemIds = items.map((i) => i.menu_item_id);
    const priceResult = await client.query(
      "SELECT id, price FROM menu_items WHERE id = ANY($1)",
      [itemIds],
    );
    const priceMap = {};
    priceResult.rows.forEach((row) => {
      priceMap[row.id] = parseFloat(row.price);
    });

    let itemsTotal = 0;
    for (const item of items) {
      const price = priceMap[item.menu_item_id];
      if (price === undefined) {
        throw new Error(`Menu item ${item.menu_item_id} not found`);
      }
      itemsTotal += price * item.quantity;
    }

    // Work out the delivery fee: this vendor's fee for this zone if
    // they've set one, otherwise their flat delivery_fee. If no zone
    // was sent at all (e.g. guest checkout), delivery fee is 0 -
    // the app should show that clearly at checkout in that case.
    let deliveryFee = 0;
    if (zone_id) {
      const feeResult = await client.query(
        `SELECT COALESCE(vzf.delivery_fee, v.delivery_fee) AS delivery_fee
         FROM vendors v
         LEFT JOIN vendor_zone_fees vzf
           ON vzf.vendor_id = v.id AND vzf.zone_id = $1
         WHERE v.id = $2`,
        [zone_id, vendor_id],
      );
      if (feeResult.rows[0]) {
        deliveryFee = parseFloat(feeResult.rows[0].delivery_fee) || 0;
      }
    }

    const total = itemsTotal + deliveryFee;

    // req.customerId is only set if optionalCustomerAuth found a valid
    // customer token - otherwise this stays undefined/null (guest order).
    const orderResult = await client.query(
      `INSERT INTO orders (vendor_id, customer_id, customer_name, customer_phone, delivery_address, zone_id, delivery_fee, total_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        vendor_id,
        req.customerId || null,
        customer_name,
        customer_phone,
        delivery_address,
        zone_id || null,
        deliveryFee,
        total,
      ],
    );
    const order = orderResult.rows[0];

    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, quantity, price_at_purchase)
         VALUES ($1, $2, $3, $4)`,
        [
          order.id,
          item.menu_item_id,
          item.quantity,
          priceMap[item.menu_item_id],
        ],
      );
    }

    await client.query("COMMIT");
    res.status(201).json(order);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Something went wrong creating the order" });
  } finally {
    client.release();
  }
});

// -----------------------------------------
// GET /api/orders  (PROTECTED - vendor dashboard only)
// Lists all orders for the LOGGED-IN vendor.
// -----------------------------------------
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         o.*,
         COALESCE(
           json_agg(
             json_build_object('name', mi.name, 'quantity', oi.quantity)
           ) FILTER (WHERE oi.id IS NOT NULL),
           '[]'
         ) AS items
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
       WHERE o.vendor_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [req.vendorId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching orders" });
  }
});

// -----------------------------------------
// PATCH /api/orders/:id/status  (PROTECTED - vendor dashboard only)
// -----------------------------------------
router.patch("/:id/status", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!VALID_STATUSES.includes(status)) {
    return res
      .status(400)
      .json({ error: `Status must be one of: ${VALID_STATUSES.join(", ")}` });
  }

  try {
    const result = await db.query(
      `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 AND vendor_id = $3 RETURNING *`,
      [status, id, req.vendorId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong updating the order" });
  }
});

module.exports = router;
