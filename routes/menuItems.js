// routes/menuItems.js
// Defines what happens when the frontend hits /api/menu-items
// All routes here are PROTECTED - requireAuth runs first on every one,
// and req.vendorId is trusted instead of any vendor_id sent by the client.

const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");

router.use(requireAuth); // applies to every route defined below in this file

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
  const { name, description, price, photo_url, category, tag } = req.body;

  try {
    const result = await db.query(
      `INSERT INTO menu_items (vendor_id, name, description, price, photo_url, category, tag)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        req.vendorId,
        name,
        description,
        price,
        photo_url || "",
        category || "Uncategorized",
        tag || null,
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

// PATCH /api/menu-items/:id
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { name, description, price, category, tag, is_available } = req.body;

  try {
    // The "AND vendor_id = $8" is important: it stops vendor A from
    // editing vendor B's items just by guessing an item id.
    const result = await db.query(
      `UPDATE menu_items SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         price = COALESCE($3, price),
         category = COALESCE($4, category),
         tag = COALESCE($5, tag),
         is_available = COALESCE($6, is_available)
       WHERE id = $7 AND vendor_id = $8
       RETURNING *`,
      [name, description, price, category, tag, is_available, id, req.vendorId],
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
  const { id } = req.params;

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
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong deleting the menu item" });
  }
});

module.exports = router;
