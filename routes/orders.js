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

// Which statuses a vendor can move an order TO, given its CURRENT status.
// This stops both accidental mistakes (double-clicking a stale dashboard
// button) and misuse (a token trying to jump an order straight to
// "delivered").
//
// - "accepted" is the "Preparing" column in the vendor's inbox.
//   "preparing" is kept so older orders and the old dashboard still work.
// - "picked_up" means the vendor confirmed they handed the order to a rider.
//   A vendor can NOT mark an order "delivered" - that will be set by the
//   customer confirming they received it (a later stage).
const ALLOWED_TRANSITIONS = {
  placed: ["accepted", "cancelled"],
  accepted: ["preparing", "ready", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["picked_up", "cancelled"],
  picked_up: [],
  delivered: [],
  cancelled: [],
};

const HISTORY_PAGE_SIZE = 20;
const ID_PATTERN = /^\d+$/;

// -----------------------------------------
// POST /api/orders  (PUBLIC - called by the Customer App, guest or logged-in)
// Creates a new order with one or more items, plus the correct delivery
// fee for the given zone (falls back to the vendor's flat fee if the
// customer has no zone, or the vendor hasn't set one for that zone).
// -----------------------------------------
router.post("/", optionalCustomerAuth, async (req, res) => {
  const {
    vendor_id,
    customer_name,
    customer_phone,
    delivery_address,
    zone_id,
    items,
    idempotency_key,
    notes,
  } = req.body;

  if (!vendor_id) {
    return res.status(400).json({ error: "vendor_id is required" });
  }

  if (!items || items.length === 0) {
    return res
      .status(400)
      .json({ error: "An order must include at least one item" });
  }

  // Validate item shape up front - every item needs a real menu_item_id
  // and a positive integer quantity. Catches negative/zero/fractional
  // quantities before they ever touch the total.
  for (const item of items) {
    const qty = item.quantity;
    if (
      !item.menu_item_id ||
      !Number.isInteger(qty) ||
      qty <= 0 ||
      qty > 100 // sanity ceiling - a single line item shouldn't be triple digits
    ) {
      return res.status(400).json({
        error: `Invalid quantity for menu item ${item.menu_item_id}`,
      });
    }
  }

  // Special instructions from the customer (optional, e.g. "No onions").
  let cleanNotes = null;
  if (notes !== undefined && notes !== null) {
    if (typeof notes !== "string" || notes.length > 500) {
      return res
        .status(400)
        .json({ error: "Notes must be text of 500 characters or less" });
    }
    cleanNotes = notes.trim() || null;
  }

  const client = await db.getClient();

  try {
    await client.query("BEGIN");

    // If the caller sent an idempotency_key, check whether we've already
    // created an order for this vendor+key. If so, just return that order
    // instead of creating a duplicate (handles double-taps and retries).
    if (idempotency_key) {
      const existing = await client.query(
        `SELECT * FROM orders WHERE vendor_id = $1 AND idempotency_key = $2`,
        [vendor_id, idempotency_key],
      );
      if (existing.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(200).json(existing.rows[0]);
      }
    }

    // Confirm the vendor actually exists and is currently active -
    // stops orders being created against a deleted/deactivated vendor.
    const vendorResult = await client.query(
      "SELECT id FROM vendors WHERE id = $1 AND is_active = true",
      [vendor_id],
    );
    if (vendorResult.rows.length === 0) {
      throw Object.assign(new Error("Vendor not found or inactive"), {
        statusCode: 404,
      });
    }

    const itemIds = items.map((i) => i.menu_item_id);

    // CRITICAL: only fetch items that both (a) belong to THIS vendor and
    // (b) are currently available. Previously this queried by item id
    // alone, so a client could send vendor A's id with vendor B's menu
    // item ids and the order would be created anyway - wrong vendor gets
    // credited/paid for someone else's food.
    const priceResult = await client.query(
      `SELECT id, price FROM menu_items
       WHERE id = ANY($1) AND vendor_id = $2 AND is_available = true`,
      [itemIds, vendor_id],
    );
    const priceMap = {};
    priceResult.rows.forEach((row) => {
      priceMap[row.id] = parseFloat(row.price);
    });

    let itemsTotal = 0;
    for (const item of items) {
      const price = priceMap[item.menu_item_id];
      if (price === undefined) {
        // Either the item doesn't exist, belongs to a different vendor,
        // or is currently unavailable - all equally invalid here.
        throw Object.assign(
          new Error(
            `Menu item ${item.menu_item_id} is not available from this vendor`,
          ),
          { statusCode: 400 },
        );
      }
      itemsTotal += price * item.quantity;
    }

    // Work out the delivery fee: this vendor's fee for this zone if
    // they've set one, otherwise their flat delivery_fee. If no zone
    // was sent at all (e.g. guest checkout), delivery fee is 0 -
    // the app should show that clearly at checkout in that case.
    let deliveryFee = 0;
    if (zone_id) {
      const feeResult = await client.query(
        `SELECT COALESCE(vzf.delivery_fee, v.delivery_fee) AS delivery_fee
         FROM vendors v
         LEFT JOIN vendor_zone_fees vzf
           ON vzf.vendor_id = v.id AND vzf.zone_id = $1
         WHERE v.id = $2`,
        [zone_id, vendor_id],
      );
      if (feeResult.rows[0]) {
        deliveryFee = parseFloat(feeResult.rows[0].delivery_fee) || 0;
      }
    }

    const total = itemsTotal + deliveryFee;

    // req.customerId is only set if optionalCustomerAuth found a valid
    // customer token - otherwise this stays undefined/null (guest order).
    const orderResult = await client.query(
      `INSERT INTO orders (vendor_id, customer_id, customer_name, customer_phone, delivery_address, zone_id, delivery_fee, total_amount, idempotency_key, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        vendor_id,
        req.customerId || null,
        customer_name,
        customer_phone,
        delivery_address,
        zone_id || null,
        deliveryFee,
        total,
        idempotency_key || null,
        cleanNotes,
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

    // First entry in this order's timeline: it was placed.
    await client.query(
      `INSERT INTO order_status_history (order_id, status, changed_by_type, changed_by_id)
       VALUES ($1, 'placed', $2, $3)`,
      [order.id, req.customerId ? "customer" : "guest", req.customerId || null],
    );

    await client.query("COMMIT");
    res.status(201).json(order);
  } catch (err) {
    await client.query("ROLLBACK");

    // A duplicate idempotency_key slipping through a race (two identical
    // requests in flight at once) hits the DB unique constraint - treat
    // that the same as the "already exists" case above.
    if (err.code === "23505" && idempotency_key) {
      const existing = await db.query(
        `SELECT * FROM orders WHERE vendor_id = $1 AND idempotency_key = $2`,
        [vendor_id, idempotency_key],
      );
      if (existing.rows.length > 0) {
        return res.status(200).json(existing.rows[0]);
      }
    }

    console.error(err);
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      error:
        statusCode === 500
          ? "Something went wrong creating the order"
          : err.message,
    });
  } finally {
    client.release();
  }
});

// -----------------------------------------
// GET /api/orders  (PROTECTED - vendor dashboard only)
// OLD endpoint: lists ALL orders for the logged-in vendor. Kept so the
// current vendor dashboard keeps working. The new Order Inbox uses
// /active and /history below instead, and this gets removed later.
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
// GET /api/orders/active  (PROTECTED - vendor dashboard only)
// Orders still being worked on: new, preparing (accepted), ready.
// Includes the times each step happened, for the inbox cards.
//
// TODO (payments phase): once real payments are wired up, only show
// orders whose payment_status is 'success'. Right now every order is
// unpaid test data, so this shows them regardless.
// -----------------------------------------
router.get("/active", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         o.id, o.status, o.customer_name, o.customer_phone, o.delivery_address,
         o.notes, o.total_amount, o.delivery_fee, o.payment_status, o.created_at,
         (SELECT MIN(h.created_at) FROM order_status_history h
            WHERE h.order_id = o.id AND h.status = 'accepted') AS accepted_at,
         (SELECT MIN(h.created_at) FROM order_status_history h
            WHERE h.order_id = o.id AND h.status = 'ready') AS ready_at,
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
         AND o.status IN ('placed', 'accepted', 'preparing', 'ready')
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
// GET /api/orders/history  (PROTECTED - vendor dashboard only)
// Finished orders for the Order History screen, newest first, paginated.
//   ?status=completed (default) | cancelled
//   ?search=   order number (e.g. 1044 or #1044), customer name or phone
//   ?date=2026-10-07   only orders finished on that day (Nigerian time)
//   ?page=1
// Also returns the numbers for the three summary cards.
// "Completed" means the vendor confirmed handoff to a rider.
// -----------------------------------------
router.get("/history", requireAuth, async (req, res) => {
  const { search, date, status, page } = req.query;

  if (date !== undefined) {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date must look like 2026-10-07" });
    }
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const offset = (pageNum - 1) * HISTORY_PAGE_SIZE;
  const statuses =
    status === "cancelled" ? ["cancelled"] : ["picked_up", "delivered"];

  const params = [req.vendorId, statuses];
  const conditions = ["o.vendor_id = $1", "o.status = ANY($2)"];

  const term = String(search || "")
    .trim()
    .replace(/^#/, "");
  if (term) {
    params.push(`%${term}%`);
    const likeIdx = params.length;
    params.push(term);
    const exactIdx = params.length;
    conditions.push(
      `(o.id::text = $${exactIdx} OR o.customer_name ILIKE $${likeIdx} OR o.customer_phone ILIKE $${likeIdx})`,
    );
  }

  let dateSql = "";
  if (date) {
    params.push(date);
    dateSql = `WHERE (COALESCE(t.handed_off_at, t.created_at::timestamptz) AT TIME ZONE 'Africa/Lagos')::date = $${params.length}::date`;
  }

  const baseSql = `
    SELECT
      o.id, o.status, o.customer_name, o.customer_phone, o.delivery_address,
      o.notes, o.total_amount, o.payment_status, o.created_at,
      (SELECT MIN(h.created_at) FROM order_status_history h
         WHERE h.order_id = o.id AND h.status IN ('picked_up', 'delivered')) AS handed_off_at,
      COALESCE(
        json_agg(
          json_build_object('name', mi.name, 'quantity', oi.quantity)
        ) FILTER (WHERE oi.id IS NOT NULL),
        '[]'
      ) AS items
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE ${conditions.join(" AND ")}
    GROUP BY o.id`;

  // Numbers for the three summary cards. "Today" is Nigerian time.
  const completedToday = `o.status IN ('picked_up', 'delivered')
    AND (hh.handed_off_at AT TIME ZONE 'Africa/Lagos')::date =
        (NOW() AT TIME ZONE 'Africa/Lagos')::date`;
  const statsSql = `
    SELECT
      COUNT(*) FILTER (WHERE ${completedToday}) AS completed_today,
      COALESCE(SUM(o.total_amount) FILTER (
        WHERE ${completedToday} AND o.payment_status = 'success'
      ), 0) AS completed_today_value,
      COUNT(*) FILTER (WHERE o.status = 'placed') AS inbox_new,
      COUNT(*) FILTER (WHERE o.status IN ('accepted', 'preparing')) AS inbox_preparing,
      COUNT(*) FILTER (WHERE o.status = 'ready') AS inbox_ready
    FROM orders o
    LEFT JOIN LATERAL (
      SELECT MIN(h.created_at) AS handed_off_at
      FROM order_status_history h
      WHERE h.order_id = o.id AND h.status IN ('picked_up', 'delivered')
    ) hh ON true
    WHERE o.vendor_id = $1`;

  try {
    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;

    const [listResult, countResult, statsResult] = await Promise.all([
      db.query(
        `SELECT t.* FROM (${baseSql}) t ${dateSql}
         ORDER BY COALESCE(t.handed_off_at, t.created_at::timestamptz) DESC, t.id DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        [...params, HISTORY_PAGE_SIZE, offset],
      ),
      db.query(`SELECT COUNT(*) FROM (${baseSql}) t ${dateSql}`, params),
      db.query(statsSql, [req.vendorId]),
    ]);

    const s = statsResult.rows[0];
    res.json({
      orders: listResult.rows,
      page: pageNum,
      page_size: HISTORY_PAGE_SIZE,
      total: parseInt(countResult.rows[0].count, 10),
      stats: {
        completed_today: parseInt(s.completed_today, 10),
        completed_today_value: parseFloat(s.completed_today_value),
        inbox_new: parseInt(s.inbox_new, 10),
        inbox_preparing: parseInt(s.inbox_preparing, 10),
        inbox_ready: parseInt(s.inbox_ready, 10),
      },
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong fetching order history" });
  }
});

// -----------------------------------------
// GET /api/orders/:id  (PROTECTED - vendor dashboard only)
// One order in full: details, items with prices, and its status timeline.
// Scoped to the logged-in vendor, so another vendor's order is a 404.
// -----------------------------------------
router.get("/:id", requireAuth, async (req, res) => {
  if (!ID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  const id = parseInt(req.params.id, 10);

  try {
    const orderResult = await db.query(
      `SELECT id, status, customer_name, customer_phone, delivery_address,
              notes, total_amount, delivery_fee, payment_status, created_at
       FROM orders WHERE id = $1 AND vendor_id = $2`,
      [id, req.vendorId],
    );
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    const [itemsResult, historyResult] = await Promise.all([
      db.query(
        `SELECT mi.name, oi.quantity, oi.price_at_purchase
         FROM order_items oi
         LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
         WHERE oi.order_id = $1
         ORDER BY oi.id`,
        [id],
      ),
      db.query(
        `SELECT status, changed_by_type, created_at
         FROM order_status_history
         WHERE order_id = $1
         ORDER BY created_at, id`,
        [id],
      ),
    ]);

    res.json({
      ...orderResult.rows[0],
      items: itemsResult.rows,
      history: historyResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching this order" });
  }
});

// -----------------------------------------
// PATCH /api/orders/:id/status  (PROTECTED - vendor dashboard only)
// Moves an order to its next status, if the move is allowed, and records
// it in the order's timeline. The order row is locked while this runs, so
// two quick clicks can't both succeed.
// -----------------------------------------
router.patch("/:id/status", requireAuth, async (req, res) => {
  if (!ID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  const id = parseInt(req.params.id, 10);
  const { status } = req.body;

  if (!VALID_STATUSES.includes(status)) {
    return res
      .status(400)
      .json({ error: `Status must be one of: ${VALID_STATUSES.join(", ")}` });
  }

  const client = await db.getClient();

  try {
    await client.query("BEGIN");

    // Vendor-scoped, so this also 404s for another vendor's order.
    const current = await client.query(
      "SELECT status FROM orders WHERE id = $1 AND vendor_id = $2 FOR UPDATE",
      [id, req.vendorId],
    );

    if (current.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }

    const currentStatus = current.rows[0].status;
    const allowedNext = ALLOWED_TRANSITIONS[currentStatus] || [];

    if (!allowedNext.includes(status)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: `Cannot move an order from "${currentStatus}" to "${status}"`,
      });
    }

    const result = await client.query(
      `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 AND vendor_id = $3 RETURNING *`,
      [status, id, req.vendorId],
    );

    await client.query(
      `INSERT INTO order_status_history (order_id, status, changed_by_type, changed_by_id)
       VALUES ($1, $2, 'vendor', $3)`,
      [id, status, req.vendorId],
    );

    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Something went wrong updating the order" });
  } finally {
    client.release();
  }
});

module.exports = router;
