// middleware/requireCustomerAuth.js
// Same pattern as requireAuth.js, but for CUSTOMERS instead of vendors.
// Re-checks is_active on every request so an admin-side suspension
// takes effect immediately rather than waiting out a 30-day token.

const jwt = require("jsonwebtoken");
const db = require("../db");

function requireCustomerAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
    // A vendor's token won't have customerId on it, so this also stops
    // a vendor's token being used to access customer-only routes.
    if (err || !decoded.customerId) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    try {
      const result = await db.query(
        "SELECT is_active FROM customers WHERE id = $1",
        [decoded.customerId],
      );
      const customer = result.rows[0];
      if (!customer || customer.is_active === false) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      req.customerId = decoded.customerId;
      next();
    } catch (dbErr) {
      console.error(dbErr);
      res.status(500).json({ error: "Something went wrong authenticating" });
    }
  });
}

module.exports = requireCustomerAuth;
