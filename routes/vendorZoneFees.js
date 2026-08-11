// routes/vendorZoneFees.js
// Lets a LOGGED-IN vendor set their own delivery fee for each zone.
// If a vendor hasn't set a fee for a zone, the customer-facing routes
// fall back to that vendor's flat "delivery_fee" automatically.

const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");

router.use(requireAuth);

// GET /api/vendor/zone-fees
// Returns EVERY zone, with this vendor's fee for it if they've set one
// (null if they haven't - the dashboard can show "using default fee" for those).
router.get("/", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT z.id AS zone_id, z.name AS zone_name, vzf.delivery_fee
       FROM zones z
       LEFT JOIN vendor_zone_fees vzf
         ON vzf.zone_id = z.id AND vzf.vendor_id = $1
       ORDER BY z.name`,
      [req.vendorId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching zone fees" });
  }
});

// PATCH /api/vendor/zone-fees/:zoneId
// Sets (or updates) this vendor's fee for one zone.
// "ON CONFLICT" means: insert a new row, but if one already exists
// for this vendor+zone, update it instead of erroring.
router.patch("/:zoneId", async (req, res) => {
  const { zoneId } = req.params;
  const { delivery_fee } = req.body;

  if (delivery_fee === undefined || delivery_fee === null) {
    return res.status(400).json({ error: "delivery_fee is required" });
  }

  try {
    const result = await db.query(
      `INSERT INTO vendor_zone_fees (vendor_id, zone_id, delivery_fee)
       VALUES ($1, $2, $3)
       ON CONFLICT (vendor_id, zone_id)
       DO UPDATE SET delivery_fee = EXCLUDED.delivery_fee
       RETURNING *`,
      [req.vendorId, zoneId, delivery_fee],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong saving the delivery fee" });
  }
});

module.exports = router;
