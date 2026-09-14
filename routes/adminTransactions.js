// routes/adminTransactions.js
// Read-only visibility into payments. Explicit column lists throughout -
// there's no card data stored anywhere in this schema to begin with,
// but keeping SELECT * out of admin routes is a habit worth having.

const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAdminAuth = require("../middleware/requireAdminAuth");

router.use(requireAdminAuth);

const PAGE_SIZE = 25;

// GET /api/admin/transactions?status=&customer_id=&vendor_id=&from=&to=&page=
router.get("/", async (req, res) => {
  const { status, customer_id, vendor_id, from, to, page = 1 } = req.query;
  const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * PAGE_SIZE;

  const conditions = [];
  const params = [];

  if (status) {
    params.push(status);
    conditions.push(`p.status = $${params.length}`);
  }
  if (customer_id) {
    params.push(customer_id);
    conditions.push(`p.customer_id = $${params.length}`);
  }
  if (vendor_id) {
    params.push(vendor_id);
    conditions.push(`o.vendor_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`p.created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`p.created_at <= $${params.length}`);
  }
  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  try {
    params.push(PAGE_SIZE, offset);
    const result = await db.query(
      `SELECT p.id, p.reference, p.provider, p.amount, p.currency, p.status,
              p.created_at, p.paid_at, p.order_id, o.vendor_id,
              v.name AS vendor_name, c.name AS customer_name
       FROM payments p
       LEFT JOIN orders o ON o.id = p.order_id
       LEFT JOIN vendors v ON v.id = o.vendor_id
       LEFT JOIN customers c ON c.id = p.customer_id
       ${whereClause}
       ORDER BY p.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const countResult = await db.query(
      `SELECT COUNT(*) FROM payments p LEFT JOIN orders o ON o.id = p.order_id ${whereClause}`,
      params.slice(0, params.length - 2),
    );

    res.json({
      transactions: result.rows,
      page: parseInt(page, 10) || 1,
      page_size: PAGE_SIZE,
      total: parseInt(countResult.rows[0].count, 10),
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong fetching transactions" });
  }
});

module.exports = router;
