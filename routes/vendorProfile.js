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
              delivery_time_estimate, delivery_fee, deal_text, rating, is_open
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
    // NOTE: "rating" is deliberately NOT accepted here. It must be
    // computed server-side from actual customer reviews - a vendor
    // being able to PATCH their own rating straight to 5 stars was
    // a real bug in the previous version of this route.
    // "is_open" is also not accepted here - it has its own route below.
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
         deal_text = COALESCE($8, deal_text)
       WHERE id = $9
       RETURNING id, name, email, phone, address, cuisine, cover_image_url,
                 delivery_time_estimate, delivery_fee, deal_text, rating, is_open`,
      [
        name,
        phone,
        address,
        cuisine,
        cover_image_url,
        delivery_time_estimate,
        delivery_fee,
        deal_text,
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

module.exports = router;
