// routes/auth.js
// Handles vendor signup and login

const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../db");

// How many "rounds" bcrypt uses to scramble the password.
// Higher = more secure but slower. 10 is a solid, standard default.
const SALT_ROUNDS = 10;

// -----------------------------------------
// POST /api/auth/signup
// Creates a new vendor account
// -----------------------------------------
router.post("/signup", async (req, res) => {
  const { name, email, password, phone, address } = req.body;

  if (!name || !email || !password) {
    return res
      .status(400)
      .json({ error: "Name, email, and password are required" });
  }

  try {
    // Check if this email is already registered
    const existing = await db.query("SELECT id FROM vendors WHERE email = $1", [
      email,
    ]);
    if (existing.rows.length > 0) {
      return res
        .status(409)
        .json({ error: "An account with this email already exists" });
    }

    // Hash the password - this is what gets stored, NEVER the real password
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await db.query(
      `INSERT INTO vendors (name, email, password_hash, phone, address)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, phone, address, created_at`,
      [name, email, passwordHash, phone, address],
    );

    const vendor = result.rows[0];

    // Immediately log them in after signup by issuing a token
    const token = jwt.sign({ vendorId: vendor.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.status(201).json({ vendor, token });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong creating the account" });
  }
});

// -----------------------------------------
// POST /api/auth/login
// Logs an existing vendor in
// -----------------------------------------
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const result = await db.query("SELECT * FROM vendors WHERE email = $1", [
      email,
    ]);
    const vendor = result.rows[0];

    // Same error message whether the email doesn't exist OR the password is wrong -
    // this is intentional, so an attacker can't figure out which emails are registered
    if (!vendor) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      vendor.password_hash,
    );
    if (!passwordMatches) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign({ vendorId: vendor.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    // Never send password_hash back to the frontend
    const { password_hash, ...vendorWithoutPassword } = vendor;

    res.json({ vendor: vendorWithoutPassword, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong logging in" });
  }
});

module.exports = router;
