// routes/adminOrders.js
// Platform-wide order visibility - unlike routes/orders.js (vendor-scoped),
// every query here is intentionally NOT filtered by vendor_id, since an
// admin needs to see across the whole platform. Every route still
// requires requireAdminAuth, so this power is admin-only.

const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAdminAuth = require("../middleware/requireAdminAuth");

router.use(requireAdminAuth);

const PAGE_SIZE = 25;

// GET /api/admin/orders?status=&vendor_id=&customer_id=&page=
router.get("/", async (req, res) => {
  const { status, vendor_id, customer_id, page = 1 } = req.query;
  const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * PAGE_SIZE;

  const conditions = [];
  const params = [];

  if (status) {
    params.push(status);
    conditions.push(`o.status = $${params.length}`);
  }
  if (vendor_id) {
    params.push(vendor_id);
    conditions.push(`o.vendor_id = $${params.length}`);
  }
  if (customer_id) {
    params.push(customer_id);
    conditions.push(`o.customer_id = $${params.length}`);
  }
  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  try {
    params.push(PAGE_SIZE, offset);
    const result = await db.query(
      `SELECT o.id, o.status, o.payment_status, o.total_amount, o.customer_name,
              o.created_at, v.name AS vendor_name, c.name AS customer_account_name
       FROM orders o
       LEFT JOIN vendors v ON v.id = o.vendor_id
       LEFT JOIN customers c ON c.id = o.customer_id
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const countResult = await db.query(
      `SELECT COUNT(*) FROM orders o ${whereClause}`,
      params.slice(0, params.length - 2),
    );

    res.json({
      orders: result.rows,
      page: parseInt(page, 10) || 1,
      page_size: PAGE_SIZE,
      total: parseInt(countResult.rows[0].count, 10),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching orders" });
  }
});

// GET /api/admin/orders/:id - full detail including items and payment history
router.get("/:id", async (req, res) => {
  try {
    const orderResult = await db.query(
      `SELECT o.*, v.name AS vendor_name, v.phone AS vendor_phone,
              c.name AS customer_account_name, c.email AS customer_email
       FROM orders o
       LEFT JOIN vendors v ON v.id = o.vendor_id
       LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.id = $1`,
      [req.params.id],
    );
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    const [itemsResult, paymentsResult] = await Promise.all([
      db.query(
        `SELECT oi.quantity, oi.price_at_purchase, mi.name
         FROM order_items oi
         LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
         WHERE oi.order_id = $1`,
        [req.params.id],
      ),
      db.query(
        // Never select card details - there aren't any stored, but this
        // is an explicit column list on purpose so a future column added
        // to `payments` doesn't silently leak here.
        `SELECT id, reference, provider, provider_ref, amount, currency,
                status, gateway_response, created_at, paid_at
         FROM payments WHERE order_id = $1 ORDER BY created_at DESC`,
        [req.params.id],
      ),
    ]);

    res.json({
      ...orderResult.rows[0],
      items: itemsResult.rows,
      payment_attempts: paymentsResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching this order" });
  }
});

module.exports = router;
