// routes/vendorDashboard.js
// Numbers for the vendor dashboard: today's sales and orders, what needs
// attention now, orders per hour, recent orders and popular items.
// Everything is scoped to the logged-in vendor, and "today" means
// today in Nigerian time (Africa/Lagos).

const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");

router.use(requireAuth);

// orders.created_at is stored as UTC without a time zone, so it is first
// marked as UTC and then converted to Nigerian time.
const CREATED_LAGOS =
  "((o.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos')";
const TODAY_LAGOS = "(NOW() AT TIME ZONE 'Africa/Lagos')::date";

// GET /api/vendor/dashboard
router.get("/", async (req, res) => {
  try {
    // 1) The headline numbers.
    const statsResult = await db.query(
      `WITH base AS (
         SELECT
           o.status, o.payment_status, o.total_amount,
           ${CREATED_LAGOS}::date AS created_day,
           (hh.handed_off_at AT TIME ZONE 'Africa/Lagos')::date AS handed_day
         FROM orders o
         LEFT JOIN LATERAL (
           SELECT MIN(h.created_at) AS handed_off_at
           FROM order_status_history h
           WHERE h.order_id = o.id AND h.status IN ('picked_up', 'delivered')
         ) hh ON true
         WHERE o.vendor_id = $1
       )
       SELECT
         COUNT(*) FILTER (
           WHERE created_day = ${TODAY_LAGOS} AND status <> 'cancelled'
         ) AS total_orders_today,
         COUNT(*) FILTER (
           WHERE created_day = ${TODAY_LAGOS} AND status <> 'cancelled'
             AND payment_status = 'success'
         ) AS sales_orders_today,
         COALESCE(SUM(total_amount) FILTER (
           WHERE created_day = ${TODAY_LAGOS} AND status <> 'cancelled'
             AND payment_status = 'success'
         ), 0) AS sales_today,
         COUNT(*) FILTER (WHERE status = 'placed') AS new_orders,
         COUNT(*) FILTER (WHERE status IN ('accepted', 'preparing')) AS preparing_orders,
         COUNT(*) FILTER (WHERE status = 'ready') AS ready_orders,
         COUNT(*) FILTER (
           WHERE status IN ('picked_up', 'delivered')
             AND handed_day = ${TODAY_LAGOS}
         ) AS completed_today,
         EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'Africa/Lagos'))::int AS current_hour,
         to_char(${TODAY_LAGOS}, 'YYYY-MM-DD') AS today
       FROM base`,
      [req.vendorId],
    );

    // 2) Orders received today, grouped by the hour they arrived.
    const hourlyResult = await db.query(
      `SELECT EXTRACT(HOUR FROM ${CREATED_LAGOS})::int AS hour,
              COUNT(*) AS orders
       FROM orders o
       WHERE o.vendor_id = $1
         AND o.status <> 'cancelled'
         AND ${CREATED_LAGOS}::date = ${TODAY_LAGOS}
       GROUP BY 1
       ORDER BY 1`,
      [req.vendorId],
    );

    // 3) The latest 4 orders.
    const recentResult = await db.query(
      `SELECT o.id, o.status, o.customer_name, o.total_amount, o.created_at,
              COALESCE(SUM(oi.quantity), 0)::int AS items_count
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.vendor_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT 4`,
      [req.vendorId],
    );

    // 4) Today's top-selling items.
    const popularResult = await db.query(
      `SELECT mi.id, mi.name, mi.price, SUM(oi.quantity)::int AS sold
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN menu_items mi ON mi.id = oi.menu_item_id
       WHERE o.vendor_id = $1
         AND o.status <> 'cancelled'
         AND ${CREATED_LAGOS}::date = ${TODAY_LAGOS}
       GROUP BY mi.id, mi.name, mi.price
       ORDER BY sold DESC, mi.name
       LIMIT 4`,
      [req.vendorId],
    );

    const s = statsResult.rows[0];
    const newOrders = parseInt(s.new_orders, 10);
    const preparingOrders = parseInt(s.preparing_orders, 10);
    const readyOrders = parseInt(s.ready_orders, 10);

    res.json({
      today: s.today,
      current_hour: s.current_hour,
      sales_today: parseFloat(s.sales_today),
      sales_orders_today: parseInt(s.sales_orders_today, 10),
      total_orders_today: parseInt(s.total_orders_today, 10),
      pending_orders: newOrders + preparingOrders + readyOrders,
      completed_today: parseInt(s.completed_today, 10),
      active: {
        new: newOrders,
        preparing: preparingOrders,
        ready: readyOrders,
      },
      hourly: hourlyResult.rows.map((r) => ({
        hour: r.hour,
        orders: parseInt(r.orders, 10),
      })),
      recent_orders: recentResult.rows.map((r) => ({
        id: r.id,
        status: r.status,
        customer_name: r.customer_name,
        total_amount: parseFloat(r.total_amount),
        items_count: r.items_count,
        created_at: r.created_at,
      })),
      popular_items: popularResult.rows.map((r) => ({
        id: r.id,
        name: r.name,
        price: parseFloat(r.price),
        sold: r.sold,
      })),
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong loading the dashboard" });
  }
});

module.exports = router;
