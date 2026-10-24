// routes/menuItems.js
// Defines what happens when the frontend hits /api/menu-items
// All routes here are PROTECTED - requireAuth runs first on every one,
// and req.vendorId is trusted instead of any vendor_id sent by the client.

const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const multer = require("multer");
const supabase = require("../lib/supabaseClient");

router.use(requireAuth); // applies to every route defined below in this file

// Store the uploaded file in memory (as a Buffer) instead of writing it
// to disk first - simpler, and fine for image-sized files.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB cap
});

const ID_PATTERN = /^\d+$/;
const PHOTO_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function has(body, key) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

// Returns a message if a value is not acceptable, otherwise null.
// With requireAll (creating an item) the name and price must be present.
function checkItemFields({ name, price, prep_time_minutes }, requireAll) {
  const nameMessage = "Item name is required (up to 120 characters)";
  if (name !== undefined && name !== null) {
    if (typeof name !== "string" || !name.trim() || name.length > 120) {
      return nameMessage;
    }
  } else if (requireAll) {
    return nameMessage;
  }

  const priceMessage = "Price must be a number above 0";
  if (price !== undefined && price !== null) {
    if (
      typeof price !== "number" ||
      !Number.isFinite(price) ||
      price <= 0 ||
      price > 10000000
    ) {
      return priceMessage;
    }
  } else if (requireAll) {
    return priceMessage;
  }

  if (prep_time_minutes !== undefined && prep_time_minutes !== null) {
    if (
      !Number.isInteger(prep_time_minutes) ||
      prep_time_minutes < 1 ||
      prep_time_minutes > 240
    ) {
      return "Prep time must be a whole number of minutes from 1 to 240";
    }
  }
  return null;
}

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

// GET /api/menu-items
// Returns all menu items for the LOGGED-IN vendor
router.get("/", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM menu_items WHERE vendor_id = $1 ORDER BY category, name",
      [req.vendorId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching menu items" });
  }
});

// POST /api/menu-items
// Creates a new menu item for the LOGGED-IN vendor
router.post("/", async (req, res) => {
  const { name, description, price, photo_url, category, tag, prep_time_minutes } =
    req.body;

  const problem = checkItemFields({ name, price, prep_time_minutes }, true);
  if (problem) return res.status(400).json({ error: problem });

  try {
    const result = await db.query(
      `INSERT INTO menu_items (vendor_id, name, description, price, photo_url, category, tag, prep_time_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        req.vendorId,
        name.trim(),
        typeof description === "string" ? description.trim() || null : null,
        price,
        photo_url || "",
        (typeof category === "string" && category.trim()) || "Uncategorized",
        tag || null,
        prep_time_minutes ?? null,
      ],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong creating the menu item" });
  }
});

// PATCH /api/menu-items/categories/rename  { from, to }
// Renames a category for every one of this vendor's items that uses it.
router.patch("/categories/rename", async (req, res) => {
  const from = typeof req.body.from === "string" ? req.body.from.trim() : "";
  const to = typeof req.body.to === "string" ? req.body.to.trim() : "";
  if (!from || !to || to.length > 60) {
    return res.status(400).json({
      error: "Enter the current and the new category name (up to 60 characters)",
    });
  }
  try {
    const result = await db.query(
      `UPDATE menu_items SET category = $1 WHERE vendor_id = $2 AND category = $3`,
      [to, req.vendorId, from],
    );
    res.json({ updated: result.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong renaming the category" });
  }
});

// POST /api/menu-items/categories/remove  { name }
// "Removes" a category by moving its items to "Uncategorized". Categories
// only exist while an item uses them.
router.post("/categories/remove", async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  if (!name) {
    return res.status(400).json({ error: "Category name is required" });
  }
  try {
    const result = await db.query(
      `UPDATE menu_items SET category = 'Uncategorized' WHERE vendor_id = $1 AND category = $2`,
      [req.vendorId, name],
    );
    res.json({ updated: result.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong removing the category" });
  }
});

// POST /api/menu-items/:id/photo
// Uploads a photo for one menu item and saves its public URL.
// upload.single("photo") means the form field must be named "photo".
router.post("/:id/photo", handlePhotoUpload, async (req, res) => {
  if (!ID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: "Invalid item id" });
  }
  const id = parseInt(req.params.id, 10);

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
    // Check the vendor owns this item BEFORE anything is uploaded.
    const owned = await db.query(
      "SELECT id FROM menu_items WHERE id = $1 AND vendor_id = $2",
      [id, req.vendorId],
    );
    if (owned.rows.length === 0) {
      return res.status(404).json({ error: "Menu item not found" });
    }

    // Unique file name: vendorId / item id + timestamp + a safe extension.
    const fileName = `${req.vendorId}/${id}-${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from("menu-photos")
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });
    if (uploadError) throw uploadError;

    // Since the bucket is public, this URL works forever without extra auth.
    const { data: publicUrlData } = supabase.storage
      .from("menu-photos")
      .getPublicUrl(fileName);

    const result = await db.query(
      `UPDATE menu_items SET photo_url = $1 WHERE id = $2 AND vendor_id = $3 RETURNING *`,
      [publicUrlData.publicUrl, id, req.vendorId],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong uploading the photo" });
  }
});

// PATCH /api/menu-items/:id
// Fields that are left out stay as they were. Description and prep time can
// also be cleared: send the key with an empty value.
router.patch("/:id", async (req, res) => {
  if (!ID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: "Invalid item id" });
  }
  const id = parseInt(req.params.id, 10);
  const { name, description, price, category, tag, is_available, prep_time_minutes } =
    req.body;

  const problem = checkItemFields({ name, price, prep_time_minutes }, false);
  if (problem) return res.status(400).json({ error: problem });
  if (
    is_available !== undefined &&
    is_available !== null &&
    typeof is_available !== "boolean"
  ) {
    return res.status(400).json({ error: "is_available must be true or false" });
  }

  const setDescription = has(req.body, "description");
  const setPrepTime = has(req.body, "prep_time_minutes");

  try {
    // The "AND vendor_id" is important: it stops vendor A from
    // editing vendor B's items just by guessing an item id.
    const result = await db.query(
      `UPDATE menu_items SET
         name = COALESCE($1, name),
         description = CASE WHEN $2::boolean THEN $3 ELSE description END,
         price = COALESCE($4, price),
         category = COALESCE($5, category),
         tag = COALESCE($6, tag),
         is_available = COALESCE($7, is_available),
         prep_time_minutes = CASE WHEN $8::boolean THEN $9::integer ELSE prep_time_minutes END
       WHERE id = $10 AND vendor_id = $11
       RETURNING *`,
      [
        typeof name === "string" ? name.trim() : null,
        setDescription,
        typeof description === "string" ? description.trim() || null : null,
        price ?? null,
        typeof category === "string" && category.trim() ? category.trim() : null,
        tag ?? null,
        is_available ?? null,
        setPrepTime,
        prep_time_minutes ?? null,
        id,
        req.vendorId,
      ],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Menu item not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong updating the menu item" });
  }
});

// DELETE /api/menu-items/:id
router.delete("/:id", async (req, res) => {
  if (!ID_PATTERN.test(req.params.id)) {
    return res.status(400).json({ error: "Invalid item id" });
  }
  const id = parseInt(req.params.id, 10);

  try {
    const result = await db.query(
      "DELETE FROM menu_items WHERE id = $1 AND vendor_id = $2 RETURNING id",
      [id, req.vendorId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Menu item not found" });
    }

    res.json({ deleted: true, id: result.rows[0].id });
  } catch (err) {
    // Postgres error code 23503 = foreign key violation. This item has
    // already been ordered at least once, so order_items still references
    // it - deleting it would corrupt past order records.
    if (err.code === "23503") {
      return res.status(409).json({
        error:
          "This item has already been ordered and can't be deleted. Mark it unavailable instead.",
      });
    }
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong deleting the menu item" });
  }
});

module.exports = router;