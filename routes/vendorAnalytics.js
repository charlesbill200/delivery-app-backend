// routes/vendorAnalytics.js
// Numbers for the vendor Analytics screen. Everything is scoped to the
// logged-in vendor, and dates are Nigerian time (Africa/Lagos).

const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");

router.use(requireAuth);

// Sales only count orders whose payment really went through. Set this to
// false to count every non-cancelled order as a sale instead.
const COUNT_ONLY_PAID_SALES = true;
const PAID = COUNT_ONLY_PAID_SALES ? "AND o.payment_status = 'success'" : "";

// orders.created_at is stored as UTC without a time zone, so it is marked
// as UTC first and then converted to Nigerian time.
const CREATED_LAGOS =
  "((o.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos')";
const IN_RANGE = `${CREATED_LAGOS}::date BETWEEN $2::date AND $3::date`;
const RANGES = ["today", "7d", "30d", "month"];

function addDays(dateString, delta) {
  const d = new Date(`${dateString}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// GET /api/vendor/analytics?range=today|7d|30d|month
router.get("/", async (req, res) => {
  const range = req.query.range || "7d";
  if (!RANGES.includes(range)) {
    return res
      .status(400)
      .json({ error: "range must be today, 7d, 30d or month" });
  }

  try {
    const todayResult = await db.query(
      "SELECT to_char((NOW() AT TIME ZONE 'Africa/Lagos')::date, 'YYYY-MM-DD') AS today",
    );
    const today = todayResult.rows[0].today;
    let start = today;
    if (range === "7d") start = addDays(today, -6);
    if (range === "30d") start = addDays(today, -29);
    if (range === "month") start = `${today.slice(0, 8)}01`;
    const days = Math.round((Date.parse(today) - Date.parse(start)) / 86400000) + 1;
    const params = [req.vendorId, start, today];

    // 1) Headline numbers and order status counts.
    const summaryResult = await db.query(
      `SELECT
         COUNT(*) AS total_orders,
         COUNT(*) FILTER (WHERE o.status = 'cancelled') AS cancelled_orders,
         COUNT(*) FILTER (WHERE o.status IN ('picked_up', 'delivered')) AS completed_orders,
         COUNT(*) FILTER (
           WHERE o.status IN ('placed', 'accepted', 'preparing', 'ready')
         ) AS in_progress_orders,
         COUNT(*) FILTER (WHERE o.status <> 'cancelled' ${PAID}) AS sales_orders,
         COALESCE(SUM(o.total_amount) FILTER (
           WHERE o.status <> 'cancelled' ${PAID}
         ), 0) AS total_sales
       FROM orders o
       WHERE o.vendor_id = $1 AND o.status <> 'pending_payment' AND ${IN_RANGE}`,
      params,
    );

    // 2) One row per day of the period (days with no orders show zero).
    const dailyResult = await db.query(
      `WITH days AS (
         SELECT ($2::date + g.n) AS day
         FROM generate_series(0, ($3::date - $2::date)) AS g(n)
       )
       SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
              COALESCE(SUM(o.total_amount) FILTER (
                WHERE o.status <> 'cancelled' ${PAID}
              ), 0) AS sales,
              COUNT(o.id) FILTER (WHERE o.status <> 'cancelled') AS orders
       FROM days
       LEFT JOIN orders o
         ON o.vendor_id = $1
        AND o.status <> 'pending_payment'
        AND ${CREATED_LAGOS}::date = days.day
       GROUP BY days.day
       ORDER BY days.day`,
      params,
    );

    // 3) The busiest hour of the day across the period.
    const hourResult = await db.query(
      `SELECT EXTRACT(HOUR FROM ${CREATED_LAGOS})::int AS hour, COUNT(*) AS orders
       FROM orders o
       WHERE o.vendor_id = $1 AND o.status NOT IN ('cancelled', 'pending_payment')
         AND ${IN_RANGE}
       GROUP BY 1
       ORDER BY orders DESC, hour
       LIMIT 1`,
      params,
    );

    // 4) Best-selling items.
    const itemsResult = await db.query(
      `SELECT mi.id, mi.name, SUM(oi.quantity)::int AS sold,
              COALESCE(SUM(oi.quantity * oi.price_at_purchase) FILTER (
                WHERE TRUE ${PAID}
              ), 0) AS sales
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN menu_items mi ON mi.id = oi.menu_item_id
       WHERE o.vendor_id = $1 AND o.status NOT IN ('cancelled', 'pending_payment')
         AND ${IN_RANGE}
       GROUP BY mi.id, mi.name
       ORDER BY sold DESC, mi.name
       LIMIT 7`,
      params,
    );

    // 5) Sales by menu category.
    const categoryResult = await db.query(
      `SELECT mi.category, SUM(oi.quantity)::int AS items,
              COALESCE(SUM(oi.quantity * oi.price_at_purchase) FILTER (
                WHERE TRUE ${PAID}
              ), 0) AS sales
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN menu_items mi ON mi.id = oi.menu_item_id
       WHERE o.vendor_id = $1 AND o.status NOT IN ('cancelled', 'pending_payment')
         AND ${IN_RANGE}
       GROUP BY mi.category
       ORDER BY sales DESC, items DESC, mi.category`,
      params,
    );

    const s = summaryResult.rows[0];
    const totalOrders = parseInt(s.total_orders, 10);
    const cancelled = parseInt(s.cancelled_orders, 10);
    const salesOrders = parseInt(s.sales_orders, 10);
    const totalSales = parseFloat(s.total_sales);

    const salesByDay = dailyResult.rows.map((r) => ({
      day: r.day,
      sales: parseFloat(r.sales),
      orders: parseInt(r.orders, 10),
    }));
    const busiest = salesByDay.reduce(
      (best, d) => (d.orders > (best ? best.orders : 0) ? d : best),
      null,
    );

    const bestSelling = itemsResult.rows.map((r) => ({
      id: r.id,
      name: r.name,
      sold: r.sold,
      sales: parseFloat(r.sales),
    }));

    const catRows = categoryResult.rows.map((r) => ({
      category: r.category,
      items: r.items,
      sales: parseFloat(r.sales),
    }));
    const catItems = catRows.reduce((sum, c) => sum + c.items, 0);
    const catSales = catRows.reduce((sum, c) => sum + c.sales, 0);
    // Share of sales; if there are no sales yet, share of items sold.
    const categories = catRows.map((c) => ({
      ...c,
      share:
        catSales > 0
          ? c.sales / catSales
          : catItems > 0
            ? c.items / catItems
            : 0,
    }));

    res.json({
      range,
      start,
      end: today,
      days,
      summary: {
        total_sales: totalSales,
        total_orders: totalOrders,
        orders_per_day: Math.round(totalOrders / days),
        average_order: salesOrders > 0 ? totalSales / salesOrders : 0,
        cancelled_orders: cancelled,
        cancellation_rate: totalOrders > 0 ? cancelled / totalOrders : 0,
      },
      sales_by_day: salesByDay,
      status: {
        completed: parseInt(s.completed_orders, 10),
        in_progress: parseInt(s.in_progress_orders, 10),
        cancelled,
      },
      busiest_day: busiest ? { day: busiest.day, orders: busiest.orders } : null,
      busiest_hour: hourResult.rows[0]
        ? {
            hour: hourResult.rows[0].hour,
            orders: parseInt(hourResult.rows[0].orders, 10),
          }
        : null,
      best_selling: bestSelling,
      best_selling_total: {
        sold: bestSelling.reduce((sum, i) => sum + i.sold, 0),
        sales: bestSelling.reduce((sum, i) => sum + i.sales, 0),
      },
      categories,
      categories_total: { items: catItems, sales: catSales },
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong loading your analytics" });
  }
});

module.exports = router;