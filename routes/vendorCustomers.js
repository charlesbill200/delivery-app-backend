// routes/vendorCustomers.js
// The vendor's customer list: only people who have ordered from THIS vendor,
// with their order history and a private note. Everything is scoped to the
// logged-in vendor.
//
// A customer is identified by a "key": c<id> for someone with an account,
// p<phone digits> for a guest (grouped by phone number, with Nigerian
// 0803... numbers treated the same as 234803...).

const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");

router.use(requireAuth);

const PAGE_SIZE = 20;
const KEY_PATTERN = /^[cp]\d{1,20}$/;

// "Total spent" only counts orders whose payment went through. Set this to
// false to count every non-cancelled order instead.
const COUNT_ONLY_PAID = true;
const PAID_FILTER = COUNT_ONLY_PAID ? "FILTER (WHERE payment_status = 'success')" : "";
const PAID_COND = COUNT_ONLY_PAID ? "AND payment_status = 'success'" : "";

const SORTS = {
  recent: "agg.last_order_at DESC",
  orders: "agg.orders DESC, agg.last_order_at DESC",
  spent: "agg.spent DESC, agg.orders DESC",
  name: "display_name ASC",
};

const DIGITS = "regexp_replace(o.customer_phone, '\\D', '', 'g')";
const KEYED_ORDERS = `
  SELECT o.*,
    CASE
      WHEN o.customer_id IS NOT NULL THEN 'c' || o.customer_id::text
      ELSE 'p' || CASE
        WHEN ${DIGITS} LIKE '0%' AND length(${DIGITS}) = 11
          THEN '234' || substr(${DIGITS}, 2)
        ELSE ${DIGITS}
      END
    END AS customer_key
  FROM orders o
  WHERE o.vendor_id = $1 AND o.status <> 'pending_payment'`;

const DIRECTORY_CTE = `
  WITH k AS (${KEYED_ORDERS}),
  agg AS (
    SELECT customer_key,
      (array_agg(customer_name ORDER BY created_at DESC))[1] AS name,
      (array_agg(customer_phone ORDER BY created_at DESC))[1] AS phone,
      MAX(customer_id) AS customer_id,
      COUNT(*) AS orders,
      COALESCE(SUM(total_amount) ${PAID_FILTER}, 0) AS spent,
      MAX(created_at) AS last_order_at
    FROM k
    WHERE status <> 'cancelled' AND customer_key <> 'p'
    GROUP BY customer_key
  )`;

function tagFor(orders) {
  if (orders >= 5) return "Regular";
  if (orders >= 2) return "Returning";
  return "New";
}

// GET /api/vendor/customers?search=&sort=recent|orders|spent|name&page=1
router.get("/", async (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const sort = SORTS[req.query.sort] ? req.query.sort : "recent";
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const params = [req.vendorId];
  let searchSql = "";
  if (search) {
    params.push(`%${search}%`);
    searchSql = `AND (COALESCE(c.name, agg.name) ILIKE $2 OR c.email ILIKE $2 OR agg.phone ILIKE $2)`;
  }

  try {
    const listResult = await db.query(
      `${DIRECTORY_CTE}
       SELECT agg.customer_key, agg.phone, agg.orders, agg.spent, agg.last_order_at,
              COALESCE(c.name, agg.name) AS display_name, c.email
       FROM agg
       LEFT JOIN customers c ON c.id = agg.customer_id
       WHERE TRUE ${searchSql}
       ORDER BY ${SORTS[sort]}, agg.customer_key
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, PAGE_SIZE, offset],
    );
    const countResult = await db.query(
      `${DIRECTORY_CTE}
       SELECT COUNT(*) FROM agg
       LEFT JOIN customers c ON c.id = agg.customer_id
       WHERE TRUE ${searchSql}`,
      params,
    );

    res.json({
      customers: listResult.rows.map((r) => ({
        key: r.customer_key,
        name: r.display_name,
        email: r.email || null,
        phone: r.phone,
        orders: parseInt(r.orders, 10),
        total_spent: parseFloat(r.spent),
        last_order_at: r.last_order_at,
      })),
      page,
      page_size: PAGE_SIZE,
      total: parseInt(countResult.rows[0].count, 10),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong loading your customers" });
  }
});

// GET /api/vendor/customers/:key - one customer in detail
router.get("/:key", async (req, res) => {
  const key = req.params.key;
  if (!KEY_PATTERN.test(key)) {
    return res.status(400).json({ error: "Invalid customer" });
  }

  try {
    const profileResult = await db.query(
      `WITH k AS (${KEYED_ORDERS})
       SELECT
         (array_agg(k.customer_name ORDER BY k.created_at DESC))[1] AS name,
         (array_agg(k.customer_phone ORDER BY k.created_at DESC))[1] AS phone,
         (array_agg(k.delivery_address ORDER BY k.created_at DESC))[1] AS address,
         MAX(k.customer_id) AS customer_id,
         MIN(k.created_at) AS first_order_at,
         COUNT(*) FILTER (WHERE k.status <> 'cancelled') AS orders,
         COALESCE(SUM(k.total_amount) FILTER (
           WHERE k.status <> 'cancelled' ${PAID_COND.replace("payment_status", "k.payment_status")}
         ), 0) AS spent,
         COUNT(*) FILTER (
           WHERE k.status <> 'cancelled' ${PAID_COND.replace("payment_status", "k.payment_status")}
         ) AS paid_orders
       FROM k
       WHERE k.customer_key = $2`,
      [req.vendorId, key],
    );
    const p = profileResult.rows[0];
    if (!p.first_order_at) {
      return res.status(404).json({ error: "Customer not found" });
    }

    let account = null;
    if (p.customer_id) {
      const accountResult = await db.query(
        "SELECT name, email FROM customers WHERE id = $1",
        [p.customer_id],
      );
      account = accountResult.rows[0] || null;
    }

    const recentResult = await db.query(
      `WITH k AS (${KEYED_ORDERS})
       SELECT k.id, k.status, k.total_amount, k.created_at,
              COALESCE(SUM(oi.quantity), 0)::int AS items_count
       FROM k
       LEFT JOIN order_items oi ON oi.order_id = k.id
       WHERE k.customer_key = $2
       GROUP BY k.id, k.status, k.total_amount, k.created_at
       ORDER BY k.created_at DESC, k.id DESC
       LIMIT 5`,
      [req.vendorId, key],
    );

    const noteResult = await db.query(
      "SELECT note FROM vendor_customer_notes WHERE vendor_id = $1 AND customer_key = $2",
      [req.vendorId, key],
    );

    const orders = parseInt(p.orders, 10);
    const paidOrders = parseInt(p.paid_orders, 10);
    const spent = parseFloat(p.spent);

    res.json({
      key,
      name: account ? account.name : p.name,
      email: account ? account.email : null,
      phone: p.phone,
      address: p.address,
      customer_since: p.first_order_at,
      orders,
      total_spent: spent,
      average_order: paidOrders > 0 ? spent / paidOrders : 0,
      tag: tagFor(orders),
      note: noteResult.rows[0] ? noteResult.rows[0].note : "",
      recent_orders: recentResult.rows.map((r) => ({
        id: r.id,
        status: r.status,
        total_amount: parseFloat(r.total_amount),
        items_count: r.items_count,
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong loading this customer" });
  }
});

// PUT /api/vendor/customers/:key/note  { note }
// Saves the vendor's private note about a customer (empty text removes it).
router.put("/:key/note", async (req, res) => {
  const key = req.params.key;
  if (!KEY_PATTERN.test(key)) {
    return res.status(400).json({ error: "Invalid customer" });
  }
  const raw = req.body.note;
  if (raw !== undefined && raw !== null && typeof raw !== "string") {
    return res.status(400).json({ error: "Note must be text" });
  }
  const note = (raw || "").trim();
  if (note.length > 500) {
    return res.status(400).json({ error: "Note can be up to 500 characters" });
  }

  try {
    // Only customers who have ordered from this vendor can have a note.
    const exists = await db.query(
      `WITH k AS (${KEYED_ORDERS}) SELECT 1 FROM k WHERE customer_key = $2 LIMIT 1`,
      [req.vendorId, key],
    );
    if (exists.rows.length === 0) {
      return res.status(404).json({ error: "Customer not found" });
    }

    if (!note) {
      await db.query(
        "DELETE FROM vendor_customer_notes WHERE vendor_id = $1 AND customer_key = $2",
        [req.vendorId, key],
      );
    } else {
      await db.query(
        `INSERT INTO vendor_customer_notes (vendor_id, customer_key, note)
         VALUES ($1, $2, $3)
         ON CONFLICT (vendor_id, customer_key)
         DO UPDATE SET note = EXCLUDED.note, updated_at = NOW()`,
        [req.vendorId, key, note],
      );
    }
    res.json({ note });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving the note" });
  }
});

module.exports = router;