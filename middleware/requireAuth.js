// middleware/requireAuth.js
// This function runs BEFORE a protected route.
// Its job: check the request has a valid token, and if so,
// attach the vendor's ID to the request so the route knows who's asking.

const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  // Tokens are sent in a header like: "Authorization: Bearer <token>"
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.vendorId = decoded.vendorId; // routes can now read req.vendorId
    next(); // token is valid - let the request continue to the actual route
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

module.exports = requireAuth;
