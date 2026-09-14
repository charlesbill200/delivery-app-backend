// routes/adminDashboard.js
// Every number here comes from an actual query - no placeholder/fake
// stats, per the master prompt's explicit rule against fabricated
// dashboard numbers.

const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAdminAuth = require("../middleware/requireAdminAuth");

router.use(requireAdminAuth);

// GET /api/admin/dashboard
router.get("/", async (req, res) => {
  try {
    // Run everything in parallel - these are independent read-only
    // aggregate queries, no reason to serialize them.
    const [
      customerCount,
      vendorCount,
      orderCounts,
      todayOrders,
      revenue,
      todayRevenue,
    ] = await Promise.all([
      db.query("SELECT COUNT(*) FROM customers"),
      db.query("SELECT COUNT(*) FROM vendors"),
      db.query(`SELECT status, COUNT(*) FROM orders GROUP BY status`),
      // "today" here means real orders only - a still-unpaid checkout
      // attempt (pending_payment) never became an order the vendor saw,
      // so it shouldn't count toward "orders today" either.
      db.query(
        `SELECT COUNT(*) FROM orders
         WHERE created_at >= CURRENT_DATE AND status != 'pending_payment'`,
      ),
      // Revenue = sum of orders whose PAYMENT actually succeeded, not
      // just any order that exists - an unpaid/failed order isn't revenue.
      db.query(
        `SELECT COALESCE(SUM(total_amount), 0) AS total
         FROM orders WHERE payment_status = 'success'`,
      ),
      db.query(
        `SELECT COALESCE(SUM(total_amount), 0) AS total
         FROM orders WHERE payment_status = 'success' AND created_at >= CURRENT_DATE`,
      ),
    ]);

    const statusBreakdown = {};
    orderCounts.rows.forEach((row) => {
      statusBreakdown[row.status] = parseInt(row.count, 10);
    });

    // "Total orders" = orders that actually happened (payment went
    // through at some point in their life) - abandoned/unpaid checkout
    // attempts are tracked separately below instead of inflating this
    // number, since they were never a real order to begin with.
    const abandonedPaymentCount = statusBreakdown.pending_payment || 0;
    const totalOrders = Object.entries(statusBreakdown)
      .filter(([status]) => status !== "pending_payment")
      .reduce((sum, [, count]) => sum + count, 0);

    res.json({
      total_customers: parseInt(customerCount.rows[0].count, 10),
      total_vendors: parseInt(vendorCount.rows[0].count, 10),
      total_orders: totalOrders,
      abandoned_payment_orders: abandonedPaymentCount,
      orders_today: parseInt(todayOrders.rows[0].count, 10),
      orders_by_status: statusBreakdown,
      pending_orders: statusBreakdown.placed || 0,
      completed_orders: statusBreakdown.delivered || 0,
      cancelled_orders: statusBreakdown.cancelled || 0,
      total_revenue: parseFloat(revenue.rows[0].total),
      revenue_today: parseFloat(todayRevenue.rows[0].total),
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong loading the dashboard" });
  }
});

module.exports = router;
