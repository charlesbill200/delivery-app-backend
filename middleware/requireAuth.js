// middleware/requireAuth.js
// This function runs BEFORE a protected vendor route.
// Its job: check the request has a valid token, that the vendor account
// is still active (a suspension made in the Admin Panel takes effect
// immediately, not after the vendor's 7-day token happens to expire),
// and if so, attach the vendor's ID to the request.

const jwt = require("jsonwebtoken");
const db = require("../db");

function requireAuth(req, res, next) {
  // Tokens are sent in a header like: "Authorization: Bearer <token>"
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    try {
      const result = await db.query(
        "SELECT is_active FROM vendors WHERE id = $1",
        [decoded.vendorId],
      );
      const vendor = result.rows[0];
      if (!vendor || vendor.is_active === false) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      req.vendorId = decoded.vendorId; // routes can now read req.vendorId
      next();
    } catch (dbErr) {
      console.error(dbErr);
      res.status(500).json({ error: "Something went wrong authenticating" });
    }
  });
}

module.exports = requireAuth;
