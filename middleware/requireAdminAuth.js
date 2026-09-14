// middleware/requireAdminAuth.js
// Same pattern as requireAuth.js / requireCustomerAuth.js, for ADMINS.
// An admin token has `adminId` (never vendorId/customerId), so a
// vendor's or customer's token can never be replayed here - this is
// the backend-side enforcement the master prompt requires; the admin
// frontend hiding a nav link is not sufficient on its own.

const jwt = require("jsonwebtoken");
const db = require("../db");

function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
    if (err || !decoded.adminId) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    try {
      // Re-check is_active on every request, not just at login time - an
      // admin deactivated mid-session should lose access immediately,
      // not after their token happens to expire.
      const result = await db.query(
        "SELECT id, role, is_active FROM admins WHERE id = $1",
        [decoded.adminId],
      );
      const admin = result.rows[0];
      if (!admin || !admin.is_active) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      req.adminId = admin.id;
      req.adminRole = admin.role;
      next();
    } catch (dbErr) {
      console.error(dbErr);
      res.status(500).json({ error: "Something went wrong authenticating" });
    }
  });
}

// Optional stricter gate for superadmin-only actions (e.g. creating other
// admins). Use as: router.post('/admins', requireAdminAuth, requireSuperAdmin, ...)
function requireSuperAdmin(req, res, next) {
  if (req.adminRole !== "superadmin") {
    return res
      .status(403)
      .json({ error: "This action requires superadmin access" });
  }
  next();
}

module.exports = requireAdminAuth;
module.exports.requireSuperAdmin = requireSuperAdmin;
