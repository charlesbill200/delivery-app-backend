// routes/customerAuth.js
// Handles customer signup and login - same pattern as routes/auth.js (vendors)

const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../db");

const SALT_ROUNDS = 10;

// -----------------------------------------
// POST /api/customer/auth/signup
// -----------------------------------------
router.post("/signup", async (req, res) => {
  const { name, email, password, phone, address } = req.body;

  if (!name || !email || !password) {
    return res
      .status(400)
      .json({ error: "Name, email, and password are required" });
  }

  try {
    const existing = await db.query(
      "SELECT id FROM customers WHERE email = $1",
      [email],
    );
    if (existing.rows.length > 0) {
      return res
        .status(409)
        .json({ error: "An account with this email already exists" });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await db.query(
      `INSERT INTO customers (name, email, password_hash, phone, address)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, phone, address, created_at`,
      [name, email, passwordHash, phone || null, address || null],
    );

    const customer = result.rows[0];

    const token = jwt.sign(
      { customerId: customer.id },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }, // longer than vendor tokens - customers shouldn't have to re-login often
    );

    res.status(201).json({ customer, token });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong creating the account" });
  }
});

// -----------------------------------------
// POST /api/customer/auth/login
// -----------------------------------------
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const result = await db.query("SELECT * FROM customers WHERE email = $1", [
      email,
    ]);
    const customer = result.rows[0];

    // Same generic error whether the email or password is wrong, on purpose.
    if (!customer) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      customer.password_hash,
    );
    if (!passwordMatches) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign(
      { customerId: customer.id },
      process.env.JWT_SECRET,
      { expiresIn: "30d" },
    );

    const { password_hash, ...customerWithoutPassword } = customer;

    res.json({ customer: customerWithoutPassword, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong logging in" });
  }
});

module.exports = router;
