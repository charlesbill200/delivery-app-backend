// routes/adminManagement.js
// Managing OTHER admin accounts - creating new ones, deactivating a
// departing admin's access, force-resetting a password. Every mutating
// action here requires 'superadmin', not just 'admin' - a regular admin
// being able to create/deactivate other admins would make the role
// distinction meaningless.
//
// This is what replaces running createAdmin.js or raw SQL by hand every
// time access needs to change.

const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const db = require("../db");
const requireAdminAuth = require("../middleware/requireAdminAuth");
const { requireSuperAdmin } = require("../middleware/requireAdminAuth");
const { logAdminAction } = require("../services/auditLog");

router.use(requireAdminAuth);

// GET /api/admin/admins
// Any logged-in admin can see the list (useful context: "who else has
// access"), but only a superadmin can act on it - enforced per-route below.
router.get("/", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, email, role, is_active, created_at
       FROM admins ORDER BY created_at ASC`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching admins" });
  }
});

// POST /api/admin/admins  { name, email, password, role }
router.post("/", requireSuperAdmin, async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password) {
    return res
      .status(400)
      .json({ error: "Name, email, and password are required" });
  }
  if (password.length < 8) {
    return res
      .status(400)
      .json({ error: "Password must be at least 8 characters" });
  }
  if (role && !["admin", "superadmin"].includes(role)) {
    return res
      .status(400)
      .json({ error: "Role must be 'admin' or 'superadmin'" });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO admins (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, is_active, created_at`,
      [name, email, passwordHash, role || "admin"],
    );
    const newAdmin = result.rows[0];

    await logAdminAction(req.adminId, "admin.create", "admin", newAdmin.id, {
      email,
    });

    res.status(201).json(newAdmin);
  } catch (err) {
    if (err.code === "23505") {
      return res
        .status(409)
        .json({ error: "An admin with this email already exists" });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong creating the admin" });
  }
});

// PATCH /api/admin/admins/:id/active  { is_active: true|false }
// This is how you revoke a departing admin's access immediately -
// requireAdminAuth re-checks is_active on every request, so this takes
// effect on their very next click, even mid-session.
router.patch("/:id/active", requireSuperAdmin, async (req, res) => {
  const { is_active } = req.body;
  if (typeof is_active !== "boolean") {
    return res.status(400).json({ error: "is_active must be true or false" });
  }
  if (parseInt(req.params.id, 10) === req.adminId && !is_active) {
    return res
      .status(400)
      .json({ error: "You can't deactivate your own account" });
  }

  try {
    const result = await db.query(
      `UPDATE admins SET is_active = $1 WHERE id = $2
       RETURNING id, name, email, role, is_active`,
      [is_active, req.params.id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Admin not found" });
    }

    await logAdminAction(
      req.adminId,
      is_active ? "admin.reactivate" : "admin.deactivate",
      "admin",
      req.params.id,
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong updating this admin" });
  }
});

// PATCH /api/admin/admins/:id/reset-password  { new_password }
// A superadmin forcing a password change on someone ELSE's account -
// e.g. they suspect it's compromised, or the person lost access to
// their email/2FA and can't do a normal self-service flow. Distinct
// from PATCH /api/admin/auth/change-password (self-service, requires
// the CURRENT password) - this one deliberately does not, since the
// whole point is recovering an account the original owner can't.
router.patch("/:id/reset-password", requireSuperAdmin, async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 8) {
    return res
      .status(400)
      .json({ error: "New password must be at least 8 characters" });
  }

  try {
    const newHash = await bcrypt.hash(new_password, 10);
    const result = await db.query(
      `UPDATE admins SET password_hash = $1 WHERE id = $2 RETURNING id, name, email`,
      [newHash, req.params.id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Admin not found" });
    }

    await logAdminAction(
      req.adminId,
      "admin.reset_password",
      "admin",
      req.params.id,
    );

    res.json({ message: `Password reset for ${result.rows[0].email}` });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong resetting this password" });
  }
});

module.exports = router;
