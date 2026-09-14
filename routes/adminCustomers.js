// routes/adminCustomers.js

const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAdminAuth = require("../middleware/requireAdminAuth");
const { logAdminAction } = require("../services/auditLog");

router.use(requireAdminAuth);

const PAGE_SIZE = 25;

// GET /api/admin/customers?search=&active=&page=
router.get("/", async (req, res) => {
  const { search, active, page = 1 } = req.query;
  const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * PAGE_SIZE;

  const conditions = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(
      `(name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`,
    );
  }
  if (active !== undefined) {
    params.push(active === "true");
    conditions.push(`is_active = $${params.length}`);
  }
  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  try {
    params.push(PAGE_SIZE, offset);
    // Never select password_hash - explicit column list, not SELECT *.
    const result = await db.query(
      `SELECT id, name, email, phone, is_active, created_at
       FROM customers
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const countResult = await db.query(
      `SELECT COUNT(*) FROM customers ${whereClause}`,
      params.slice(0, params.length - 2),
    );

    res.json({
      customers: result.rows,
      page: parseInt(page, 10) || 1,
      page_size: PAGE_SIZE,
      total: parseInt(countResult.rows[0].count, 10),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching customers" });
  }
});

// GET /api/admin/customers/:id - profile + order history
router.get("/:id", async (req, res) => {
  try {
    const customerResult = await db.query(
      `SELECT id, name, email, phone, address, is_active, created_at
       FROM customers WHERE id = $1`,
      [req.params.id],
    );
    if (customerResult.rows.length === 0) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const ordersResult = await db.query(
      `SELECT id, status, payment_status, total_amount, created_at
       FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id],
    );

    res.json({
      ...customerResult.rows[0],
      orders: ordersResult.rows,
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong fetching this customer" });
  }
});

// PATCH /api/admin/customers/:id/active  { is_active: true|false }
router.patch("/:id/active", async (req, res) => {
  const { is_active } = req.body;
  if (typeof is_active !== "boolean") {
    return res.status(400).json({ error: "is_active must be true or false" });
  }
  try {
    const result = await db.query(
      `UPDATE customers SET is_active = $1 WHERE id = $2 RETURNING id, name, is_active`,
      [is_active, req.params.id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Customer not found" });
    }
    await logAdminAction(
      req.adminId,
      is_active ? "customer.reactivate" : "customer.suspend",
      "customer",
      req.params.id,
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong updating this customer" });
  }
});

module.exports = router;
