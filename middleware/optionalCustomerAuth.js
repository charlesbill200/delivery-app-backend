// middleware/optionalCustomerAuth.js
// Like requireCustomerAuth, but never blocks the request.
// If a valid customer token is present, req.customerId gets set.
// If there's no token (guest checkout) or a bad one, req.customerId
// is just left undefined and the request continues anyway.

const jwt = require("jsonwebtoken");

function optionalCustomerAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(); // no token - proceed as a guest
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.customerId) {
      req.customerId = decoded.customerId;
    }
  } catch (err) {
    // Invalid/expired token - just proceed as a guest instead of failing
  }

  next();
}

module.exports = optionalCustomerAuth;
