// routes/adminVendors.js

const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAdminAuth = require("../middleware/requireAdminAuth");
const { logAdminAction } = require("../services/auditLog");

router.use(requireAdminAuth);

const PAGE_SIZE = 25;

// GET /api/admin/vendors?search=&status=&page=
// status here means approval_status (pending|approved|rejected); use
// ?active=false to filter suspended vendors instead/additionally.
router.get("/", async (req, res) => {
  const { search, status, active, page = 1 } = req.query;
  const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * PAGE_SIZE;

  const conditions = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(
      `(name ILIKE $${params.length} OR email ILIKE $${params.length})`,
    );
  }
  if (status) {
    params.push(status);
    conditions.push(`approval_status = $${params.length}`);
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
    const result = await db.query(
      `SELECT id, name, email, phone, cuisine, is_active, approval_status,
              rating, created_at
       FROM vendors
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const countResult = await db.query(
      `SELECT COUNT(*) FROM vendors ${whereClause}`,
      params.slice(0, params.length - 2),
    );

    res.json({
      vendors: result.rows,
      page: parseInt(page, 10) || 1,
      page_size: PAGE_SIZE,
      total: parseInt(countResult.rows[0].count, 10),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching vendors" });
  }
});

// GET /api/admin/vendors/:id - profile + their products + recent orders
router.get("/:id", async (req, res) => {
  try {
    const vendorResult = await db.query(
      `SELECT id, name, email, phone, address, cuisine, is_active,
              approval_status, delivery_fee, rating, created_at
       FROM vendors WHERE id = $1`,
      [req.params.id],
    );
    if (vendorResult.rows.length === 0) {
      return res.status(404).json({ error: "Vendor not found" });
    }

    const [productsResult, ordersResult] = await Promise.all([
      db.query(
        `SELECT id, name, price, category, is_available
         FROM menu_items WHERE vendor_id = $1 ORDER BY category, name`,
        [req.params.id],
      ),
      db.query(
        `SELECT id, status, payment_status, total_amount, created_at
         FROM orders WHERE vendor_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [req.params.id],
      ),
    ]);

    res.json({
      ...vendorResult.rows[0],
      products: productsResult.rows,
      recent_orders: ordersResult.rows,
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong fetching this vendor" });
  }
});

// PATCH /api/admin/vendors/:id/approval  { approval_status: 'approved'|'rejected'|'pending' }
router.patch("/:id/approval", async (req, res) => {
  const { approval_status } = req.body;
  if (!["pending", "approved", "rejected"].includes(approval_status)) {
    return res.status(400).json({ error: "Invalid approval_status" });
  }
  try {
    const result = await db.query(
      `UPDATE vendors SET approval_status = $1 WHERE id = $2
       RETURNING id, name, approval_status`,
      [approval_status, req.params.id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Vendor not found" });
    }
    await logAdminAction(
      req.adminId,
      `vendor.${approval_status}`,
      "vendor",
      req.params.id,
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong updating this vendor" });
  }
});

// PATCH /api/admin/vendors/:id/active  { is_active: true|false }
// This is the suspend/reactivate action - separate from approval so a
// previously-approved vendor can be temporarily suspended without
// losing their approval record.
router.patch("/:id/active", async (req, res) => {
  const { is_active } = req.body;
  if (typeof is_active !== "boolean") {
    return res.status(400).json({ error: "is_active must be true or false" });
  }
  try {
    const result = await db.query(
      `UPDATE vendors SET is_active = $1 WHERE id = $2 RETURNING id, name, is_active`,
      [is_active, req.params.id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Vendor not found" });
    }
    await logAdminAction(
      req.adminId,
      is_active ? "vendor.reactivate" : "vendor.suspend",
      "vendor",
      req.params.id,
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong updating this vendor" });
  }
});

module.exports = router;
