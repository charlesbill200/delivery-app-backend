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
// Creates a new order with one or more items.
// -----------------------------------------
router.post("/", optionalCustomerAuth, async (req, res) => {
  const { vendor_id, customer_name, customer_phone, delivery_address, items } =
    req.body;

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

    let total = 0;
    for (const item of items) {
      const price = priceMap[item.menu_item_id];
      if (price === undefined) {
        throw new Error(`Menu item ${item.menu_item_id} not found`);
      }
      total += price * item.quantity;
    }

    // req.customerId is only set if optionalCustomerAuth found a valid
    // customer token - otherwise this stays undefined/null (guest order).
    const orderResult = await client.query(
      `INSERT INTO orders (vendor_id, customer_id, customer_name, customer_phone, delivery_address, total_amount)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        vendor_id,
        req.customerId || null,
        customer_name,
        customer_phone,
        delivery_address,
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
