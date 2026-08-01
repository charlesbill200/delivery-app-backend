// db.js
// This file's ONE job: create a connection "pool" to PostgreSQL
// and let other files use it to run queries.

const { Pool } = require("pg");
require("dotenv").config();

// Debug: show what connection string got loaded (password hidden)
console.log(
  "Loaded DATABASE_URL:",
  process.env.DATABASE_URL
    ? process.env.DATABASE_URL.replace(/:[^:@]+@/, ":****@")
    : "NOT FOUND",
);

// A "pool" manages multiple database connections for you,
// so you don't open/close a connection manually every time.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // needed for most hosted Postgres (like Supabase)
  connectionTimeoutMillis: 20000, // give up after 20s instead of hanging forever
  keepAlive: true, // helps prevent connections from silently dying
  max: 5, // limit simultaneous connections (fine for dev)
});

// Catches errors that happen on idle connections in the background
// (without this, some connection failures fail silently)
pool.on("error", (err) => {
  console.error("❌ Unexpected pool error:", err);
});

// Quick sanity check when the server starts
console.log("Attempting database connection...");
pool.query("SELECT NOW()", (err, res) => {
  if (err) {
    console.error("❌ Database connection failed:", err);
  } else {
    console.log("✅ Database connected at", res.rows[0].now);
  }
});

// We export "query" for simple one-off queries, and "getClient" for
// transactions where multiple queries must all succeed or all fail together.
module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
};
