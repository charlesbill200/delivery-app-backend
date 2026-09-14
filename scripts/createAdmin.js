// scripts/createAdmin.js
// Run this ONCE, locally, to create your first admin account. There's
// no public admin-signup endpoint on purpose - anyone who could
// register an admin account would effectively own the platform.
//
// Usage:
//   DATABASE_URL="your-connection-string" node scripts/createAdmin.js "Your Name" "you@example.com" "a-strong-password"
//
// Once you have one admin, you can create further ones through the
// Admin Panel itself (or by running this script again).

const bcrypt = require("bcrypt");
const { Pool } = require("pg");

async function main() {
  const [, , name, email, password] = process.argv;

  if (!name || !email || !password) {
    console.error(
      'Usage: node scripts/createAdmin.js "Name" "email@example.com" "password"',
    );
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL environment variable is required.");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO admins (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'superadmin')
       RETURNING id, name, email, role`,
      [name, email, passwordHash],
    );
    console.log("✅ Admin created:", result.rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      console.error("❌ An admin with that email already exists.");
    } else {
      console.error("❌ Failed to create admin:", err.message);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
