// routes/publicRoutes.js
// These routes are for CUSTOMERS - no login required.
// They only ever return safe, public information (never password_hash, etc.)

const express = require("express");
const router = express.Router();
const db = require("../db");

// GET /api/public/zones
// Returns the full list of delivery zones/areas customers can pick from.
router.get("/zones", async (req, res) => {
  try {
    const result = await db.query("SELECT id, name FROM zones ORDER BY name");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching zones" });
  }
});

// GET /api/public/vendors
// Lists all active vendors. If a zone_id is passed as a query param
// (e.g. /api/public/vendors?zone_id=2), delivery_fee reflects that
// vendor's fee FOR THAT ZONE - falling back to their flat delivery_fee
// if they haven't set a specific fee for this zone.
router.get("/vendors", async (req, res) => {
  const { zone_id } = req.query;

  try {
    const result = await db.query(
      `SELECT v.id, v.name, v.address, v.phone, v.cuisine, v.cover_image_url,
              v.delivery_time_estimate,
              COALESCE(vzf.delivery_fee, v.delivery_fee) AS delivery_fee,
              v.deal_text, v.rating
       FROM vendors v
       LEFT JOIN vendor_zone_fees vzf
         ON vzf.vendor_id = v.id AND vzf.zone_id = $1
       WHERE v.is_active = true
       ORDER BY v.name`,
      [zone_id || null],
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
