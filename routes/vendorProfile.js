// routes/vendorProfile.js
// Lets a LOGGED-IN vendor view and update their own storefront details.

const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");

router.use(requireAuth); // every route below requires a valid vendor login

// GET /api/vendor/profile
// Returns the logged-in vendor's own full profile
router.get("/profile", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, email, phone, address, cuisine, cover_image_url,
              delivery_time_estimate, delivery_fee, deal_text, rating
       FROM vendors WHERE id = $1`,
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
// Updates one or more storefront fields for the logged-in vendor
router.patch("/profile", async (req, res) => {
  const {
    name,
    phone,
    address,
    cuisine,
    cover_image_url,
    delivery_time_estimate,
    delivery_fee,
    deal_text,
    rating,
  } = req.body;

  try {
    // Same COALESCE pattern as menu items - only updates fields that were sent
    const result = await db.query(
      `UPDATE vendors SET
         name = COALESCE($1, name),
         phone = COALESCE($2, phone),
         address = COALESCE($3, address),
         cuisine = COALESCE($4, cuisine),
         cover_image_url = COALESCE($5, cover_image_url),
         delivery_time_estimate = COALESCE($6, delivery_time_estimate),
         delivery_fee = COALESCE($7, delivery_fee),
         deal_text = COALESCE($8, deal_text),
         rating = COALESCE($9, rating)
       WHERE id = $10
       RETURNING id, name, email, phone, address, cuisine, cover_image_url,
                 delivery_time_estimate, delivery_fee, deal_text, rating`,
      [
        name,
        phone,
        address,
        cuisine,
        cover_image_url,
        delivery_time_estimate,
        delivery_fee,
        deal_text,
        rating,
        req.vendorId,
      ],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong updating your profile" });
  }
});

module.exports = router;
