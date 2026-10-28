// routes/vendorProfile.js
// Lets a LOGGED-IN vendor view and update their own storefront details:
// profile, cover photo, store open/closed, opening hours and alert settings.

const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const multer = require("multer");
const supabase = require("../lib/supabaseClient");

router.use(requireAuth); // every route below requires a valid vendor login

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB cap
});
const PHOTO_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const PROFILE_COLUMNS = `id, name, email, phone, address, cuisine, cover_image_url,
  delivery_time_estimate, delivery_fee, deal_text, rating, is_open, description,
  min_order_amount, alert_sound, waiting_reminder, daily_summary`;

// GET /api/vendor/profile
router.get("/profile", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT ${PROFILE_COLUMNS} FROM vendors WHERE id = $1`,
      [req.vendorId],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong fetching your profile" });
  }
});

// PATCH /api/vendor/profile
// Only the fields that are sent are changed. Text fields that can be
// cleared (cuisine, deal text, description...) are cleared by sending an
// empty value. NOTE: "rating" and "is_open" are deliberately NOT accepted
// here (rating comes from reviews; is_open has its own route below).
router.patch("/profile", async (req, res) => {
  const body = req.body || {};
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const updates = [];
  const values = [];
  function add(column, value) {
    values.push(value);
    updates.push(`${column} = $${values.length}`);
  }

  // The store name can't be empty.
  if (has("name")) {
    if (
      typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.trim().length > 120
    ) {
      return res
        .status(400)
        .json({ error: "Store name is required (up to 120 characters)" });
    }
    add("name", body.name.trim());
  }

  // Phone and address change only when a value is sent.
  for (const [key, max] of [
    ["phone", 40],
    ["address", 300],
  ]) {
    if (has(key) && body[key] !== null && body[key] !== "") {
      if (typeof body[key] !== "string" || body[key].trim().length > max) {
        return res.status(400).json({ error: `${key} is too long` });
      }
      add(key, body[key].trim());
    }
  }

  // Text that can be cleared.
  for (const [key, max] of [
    ["cuisine", 120],
    ["cover_image_url", 500],
    ["delivery_time_estimate", 60],
    ["deal_text", 120],
    ["description", 500],
  ]) {
    if (has(key)) {
      const value = body[key];
      if (value !== null && typeof value !== "string") {
        return res.status(400).json({ error: `${key} must be text` });
      }
      const text = value ? value.trim() : "";
      if (text.length > max) {
        return res
          .status(400)
          .json({ error: `${key} must be ${max} characters or fewer` });
      }
      add(key, text || null);
    }
  }

  // Amounts in naira.
  for (const key of ["delivery_fee", "min_order_amount"]) {
    if (has(key)) {
      const n = Number(body[key]);
      if (
        body[key] === null ||
        body[key] === "" ||
        !Number.isFinite(n) ||
        n < 0 ||
        n > 10000000
      ) {
        return res.status(400).json({ error: `${key} must be 0 or more` });
      }
      add(key, n);
    }
  }

  // Alert preferences.
  for (const key of ["alert_sound", "waiting_reminder", "daily_summary"]) {
    if (has(key)) {
      if (typeof body[key] !== "boolean") {
        return res.status(400).json({ error: `${key} must be true or false` });
      }
      add(key, body[key]);
    }
  }

  try {
    if (updates.length === 0) {
      const current = await db.query(
        `SELECT ${PROFILE_COLUMNS} FROM vendors WHERE id = $1`,
        [req.vendorId],
      );
      return res.json(current.rows[0]);
    }
    values.push(req.vendorId);
    const result = await db.query(
      `UPDATE vendors SET ${updates.join(", ")}
       WHERE id = $${values.length}
       RETURNING ${PROFILE_COLUMNS}`,
      values,
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong updating your profile" });
  }
});

// PATCH /api/vendor/store-status  { is_open: true | false }
// Opens or closes the store. A closed store keeps working on the orders it
// already has, but customers can't place new ones.
router.patch("/store-status", async (req, res) => {
  const { is_open } = req.body;

  if (typeof is_open !== "boolean") {
    return res.status(400).json({ error: "is_open must be true or false" });
  }

  try {
    const result = await db.query(
      `UPDATE vendors SET is_open = $1 WHERE id = $2 RETURNING id, is_open`,
      [is_open, req.vendorId],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong updating your store status" });
  }
});

// Wraps the photo upload so a too-large or unreadable file gives a clear
// message instead of a generic server error.
function handlePhotoUpload(req, res, next) {
  upload.single("photo")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res
          .status(413)
          .json({ error: "Photo is too large (5 MB maximum)" });
      }
      return res.status(400).json({ error: "Couldn't read the photo" });
    }
    next();
  });
}

// POST /api/vendor/cover-photo  (multipart form, field name "photo")
router.post("/cover-photo", handlePhotoUpload, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No photo file was provided" });
  }
  const ext = PHOTO_TYPES[req.file.mimetype];
  if (!ext) {
    return res
      .status(400)
      .json({ error: "Photo must be a JPEG, PNG or WebP image" });
  }

  try {
    const fileName = `${req.vendorId}/cover-${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("menu-photos")
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });
    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabase.storage
      .from("menu-photos")
      .getPublicUrl(fileName);

    const result = await db.query(
      `UPDATE vendors SET cover_image_url = $1 WHERE id = $2
       RETURNING ${PROFILE_COLUMNS}`,
      [publicUrlData.publicUrl, req.vendorId],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong uploading the photo" });
  }
});

async function readOpeningHours(vendorId) {
  const result = await db.query(
    `SELECT day_of_week, is_open,
            to_char(open_time, 'HH24:MI') AS open_time,
            to_char(close_time, 'HH24:MI') AS close_time
     FROM vendor_opening_hours WHERE vendor_id = $1
     ORDER BY day_of_week`,
    [vendorId],
  );
  return { configured: result.rows.length > 0, hours: result.rows };
}

// GET /api/vendor/opening-hours
// configured is false until the vendor saves their hours for the first time
// (until then the store has no time limit).
router.get("/opening-hours", async (req, res) => {
  try {
    res.json(await readOpeningHours(req.vendorId));
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong fetching your opening hours" });
  }
});

// PUT /api/vendor/opening-hours
// Body: { hours: [ { day_of_week 0-6 (0 = Sunday), is_open, open_time "09:00",
// close_time "21:00" } x 7 ] }. A closing time earlier than the opening time
// means the hours run past midnight.
router.put("/opening-hours", async (req, res) => {
  const hours = req.body && req.body.hours;
  if (!Array.isArray(hours) || hours.length !== 7) {
    return res.status(400).json({ error: "Send the hours for all 7 days" });
  }
  const seen = new Set();
  for (const h of hours) {
    if (
      !h ||
      !Number.isInteger(h.day_of_week) ||
      h.day_of_week < 0 ||
      h.day_of_week > 6 ||
      seen.has(h.day_of_week)
    ) {
      return res.status(400).json({
        error: "Each day must appear once (0 = Sunday to 6 = Saturday)",
      });
    }
    seen.add(h.day_of_week);
    if (typeof h.is_open !== "boolean") {
      return res.status(400).json({ error: "is_open must be true or false" });
    }
    if (!TIME_PATTERN.test(h.open_time) || !TIME_PATTERN.test(h.close_time)) {
      return res.status(400).json({ error: "Times must look like 09:00" });
    }
    if (h.open_time === h.close_time) {
      return res
        .status(400)
        .json({ error: "Opening and closing time can't be the same" });
    }
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    for (const h of hours) {
      await client.query(
        `INSERT INTO vendor_opening_hours (vendor_id, day_of_week, is_open, open_time, close_time)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (vendor_id, day_of_week)
         DO UPDATE SET is_open = EXCLUDED.is_open,
                       open_time = EXCLUDED.open_time,
                       close_time = EXCLUDED.close_time`,
        [req.vendorId, h.day_of_week, h.is_open, h.open_time, h.close_time],
      );
    }
    await client.query("COMMIT");
    res.json(await readOpeningHours(req.vendorId));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong saving your opening hours" });
  } finally {
    client.release();
  }
});

module.exports = router;