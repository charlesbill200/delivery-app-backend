// routes/publicRoutes.js
// These routes are for CUSTOMERS - no login required.
// They only ever return safe, public information (never password_hash, etc.)

const express = require("express");
const router = express.Router();
const db = require("../db");

// GET /api/public/vendors
// Lists all active vendors, including the storefront display fields
// the Customer App's home screen needs (rating, delivery time, etc.)
router.get("/vendors", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, address, phone, cuisine, cover_image_url,
              delivery_time_estimate, delivery_fee, deal_text, rating
       FROM vendors
       WHERE is_active = true
       ORDER BY name`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching vendors" });
  }
});

// GET /api/public/vendors/:id/menu
// Returns one vendor's available menu items - this powers the menu browse screen
router.get("/vendors/:id/menu", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(
      `SELECT id, name, description, price, photo_url, category, tag
       FROM menu_items
       WHERE vendor_id = $1 AND is_available = true
       ORDER BY category, name`,
      [id],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching the menu" });
  }
});

module.exports = router;
