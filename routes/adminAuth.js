// routes/adminAuth.js
// Admin login only - deliberately no public admin signup route. Admin
// accounts are provisioned directly in the DB (or by a superadmin via
// POST /api/admin/admins, see adminManagement.js) rather than exposed
// as a self-serve signup form, since anyone who can register an admin
// account effectively owns the platform.

const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { loginLimiter } = require("../middleware/authRateLimit");
const { logAdminAction } = require("../services/auditLog");

router.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const result = await db.query("SELECT * FROM admins WHERE email = $1", [
      email,
    ]);
    const admin = result.rows[0];

    // Same generic message whether the email doesn't exist, the account
    // is deactivated, or the password is wrong - no enumeration.
    if (!admin || !admin.is_active) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const passwordMatches = await bcrypt.compare(password, admin.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign(
      { adminId: admin.id, role: admin.role },
      process.env.JWT_SECRET,
      {
        expiresIn: "12h", // shorter-lived than vendor/customer tokens - higher-privilege session
      },
    );

    await logAdminAction(admin.id, "admin.login", "admin", admin.id);

    const { password_hash, ...adminWithoutPassword } = admin;
    res.json({ admin: adminWithoutPassword, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong logging in" });
  }
});

module.exports = router;
