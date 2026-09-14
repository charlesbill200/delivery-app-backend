// services/auditLog.js
// One-line helper so admin routes don't repeat the same INSERT everywhere.
// Fire-and-forget by design: a logging failure should never block the
// actual admin action from completing.

const db = require("../db");

async function logAdminAction(adminId, action, targetType, targetId, details) {
  try {
    await db.query(
      `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        adminId,
        action,
        targetType || null,
        targetId || null,
        details ? JSON.stringify(details) : null,
      ],
    );
  } catch (err) {
    console.error("Failed to write admin audit log:", err);
  }
}

module.exports = { logAdminAction };
