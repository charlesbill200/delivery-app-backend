// routes/customerProfile.js
// Lets a LOGGED-IN customer view/update their profile and see their orders.

const express = require("express");
const router = express.Router();
const db = require("../db");
const requireCustomerAuth = require("../middleware/requireCustomerAuth");

router.use(requireCustomerAuth); // every route below requires a valid customer login

// GET /api/customer/profile
// Includes the zone NAME (joined in) alongside zone_id, so the app
// doesn't need a second request just to show "Okitipupa" instead of "2".
router.get("/profile", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.name, c.email, c.phone, c.address, c.zone_id,
              z.name AS zone_name, c.created_at
       FROM customers c
       LEFT JOIN zones z ON z.id = c.zone_id
       WHERE c.id = $1`,
      [req.customerId],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong fetching your profile" });
  }
});

// PATCH /api/customer/profile
router.patch("/profile", async (req, res) => {
  const { name, phone, address, zone_id } = req.body;

  try {
    const result = await db.query(
      `UPDATE customers SET
         name = COALESCE($1, name),
         phone = COALESCE($2, phone),
         address = COALESCE($3, address),
         zone_id = COALESCE($4, zone_id)
       WHERE id = $5
       RETURNING id, name, email, phone, address, zone_id, created_at`,
      [name, phone, address, zone_id, req.customerId],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong updating your profile" });
  }
});

// GET /api/customer/orders
// Returns the logged-in customer's own order history, most recent first -
// same shape as the vendor's order list (items joined in).
router.get("/orders", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         o.*,
         v.name AS vendor_name,
         COALESCE(
           json_agg(
             json_build_object('name', mi.name, 'quantity', oi.quantity)
           ) FILTER (WHERE oi.id IS NOT NULL),
           '[]'
         ) AS items
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
       LEFT JOIN vendors v ON v.id = o.vendor_id
       WHERE o.customer_id = $1
       GROUP BY o.id, v.name
       ORDER BY o.created_at DESC`,
      [req.customerId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong fetching your orders" });
  }
});

module.exports = router;
