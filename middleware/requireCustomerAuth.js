// middleware/requireCustomerAuth.js
// Same pattern as requireAuth.js, but for CUSTOMERS instead of vendors.
// Attaches req.customerId so customer-only routes know who's asking.

const jwt = require("jsonwebtoken");

function requireCustomerAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // A vendor's token won't have customerId on it, so this also stops
    // a vendor's token being used to access customer-only routes.
    if (!decoded.customerId) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    req.customerId = decoded.customerId;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

module.exports = requireCustomerAuth;
