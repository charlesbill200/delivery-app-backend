// routes/customerAuth.js
// Customer signup/login. Signup is now a two-step, OTP-verified flow:
//   1. POST /signup        - collect details, send an OTP by SMS
//   2. POST /signup/verify - confirm the code, create the account, log in
// Login accepts phone OR email, matching Chowdeck's flow.

const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { loginLimiter, signupLimiter } = require("../middleware/authRateLimit");
const { issueOtp, verifyOtp } = require("../services/otpService");

const SALT_ROUNDS = 10;

// Defaults OFF - no email/SMS provider is required to ship signup today.
// Flip OTP_ENABLED=true in Render once RESEND_API_KEY (or Termii creds,
// with OTP_CHANNEL=sms) are actually configured - nothing else in this
// file needs to change, the /signup route below branches on this flag.
const OTP_ENABLED =
  (process.env.OTP_ENABLED || "false").toLowerCase() === "true";

// -----------------------------------------
// POST /api/customer/auth/signup
// With OTP_ENABLED=false (default): creates the account immediately,
// same as a plain one-step signup.
// With OTP_ENABLED=true: Step 1 of a two-step flow - hashes the
// password and sends an OTP, doesn't create the customer row yet. The
// signup data (including the password hash) rides along as the OTP's
// pending_payload until verified, so an abandoned signup never leaves a
// half-created account behind.
// -----------------------------------------
router.post("/signup", signupLimiter, async (req, res) => {
  const { name, email, password, phone, address, zone_id, referral_code } =
    req.body;

  if (!name || !email || !password || !phone) {
    return res
      .status(400)
      .json({ error: "Name, email, phone, and password are required" });
  }

  try {
    const existingEmail = await db.query(
      "SELECT id FROM customers WHERE email = $1",
      [email],
    );
    if (existingEmail.rows.length > 0) {
      return res
        .status(409)
        .json({ error: "An account with this email already exists" });
    }

    const existingPhone = await db.query(
      "SELECT id FROM customers WHERE phone = $1",
      [phone],
    );
    if (existingPhone.rows.length > 0) {
      return res
        .status(409)
        .json({ error: "An account with this phone number already exists" });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    if (!OTP_ENABLED) {
      const result = await db.query(
        `INSERT INTO customers (name, email, password_hash, phone, address, zone_id, referral_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, email, phone, address, zone_id, referral_code, created_at`,
        [
          name,
          email,
          passwordHash,
          phone,
          address || null,
          zone_id || null,
          referral_code || null,
        ],
      );
      const customer = result.rows[0];
      const token = jwt.sign(
        { customerId: customer.id },
        process.env.JWT_SECRET,
        { expiresIn: "30d" },
      );
      return res.status(201).json({ customer, token });
    }

    await issueOtp(phone, email, "signup", {
      name,
      email,
      passwordHash,
      phone,
      address: address || null,
      zone_id: zone_id || null,
      referral_code: referral_code || null,
    });

    res.status(200).json({ message: "Verification code sent", phone });
  } catch (err) {
    if (err.statusCode)
      return res.status(err.statusCode).json({ error: err.message });
    if (err.code === "23505") {
      return res
        .status(409)
        .json({ error: "An account with this email or phone already exists" });
    }
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong starting your signup" });
  }
});

// -----------------------------------------
// POST /api/customer/auth/signup/resend
// Re-sends a code using the same pending signup data, so the customer
// doesn't have to retype everything if the first SMS doesn't arrive.
// -----------------------------------------
router.post("/signup/resend", signupLimiter, async (req, res) => {
  const { phone } = req.body;
  if (!phone)
    return res.status(400).json({ error: "Phone number is required" });

  try {
    const existing = await db.query(
      `SELECT pending_payload FROM otp_verifications
       WHERE phone = $1 AND purpose = 'signup' AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [phone],
    );
    if (!existing.rows[0]) {
      return res.status(400).json({
        error: "No pending signup found for this number - please start again",
      });
    }

    const pending = existing.rows[0].pending_payload;
    await issueOtp(phone, pending?.email, "signup", pending);
    res.json({ message: "Verification code resent" });
  } catch (err) {
    if (err.statusCode)
      return res.status(err.statusCode).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Something went wrong resending the code" });
  }
});

// -----------------------------------------
// POST /api/customer/auth/signup/verify
// Step 2: confirm the code, create the real customer row from the
// pending payload, and log them straight in.
// -----------------------------------------
router.post("/signup/verify", loginLimiter, async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) {
    return res
      .status(400)
      .json({ error: "Phone number and code are required" });
  }

  try {
    const payload = await verifyOtp(phone, "signup", code);
    if (!payload) {
      return res
        .status(400)
        .json({
          error: "Verification session not found - please sign up again",
        });
    }

    const result = await db.query(
      `INSERT INTO customers (name, email, password_hash, phone, address, zone_id, referral_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, email, phone, address, zone_id, referral_code, created_at`,
      [
        payload.name,
        payload.email,
        payload.passwordHash,
        payload.phone,
        payload.address,
        payload.zone_id,
        payload.referral_code,
      ],
    );
    const customer = result.rows[0];

    const token = jwt.sign(
      { customerId: customer.id },
      process.env.JWT_SECRET,
      { expiresIn: "30d" },
    );

    res.status(201).json({ customer, token });
  } catch (err) {
    if (err.statusCode)
      return res.status(err.statusCode).json({ error: err.message });
    if (err.code === "23505") {
      return res
        .status(409)
        .json({ error: "An account with this email or phone already exists" });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong verifying your code" });
  }
});

// -----------------------------------------
// POST /api/customer/auth/login
// Accepts phone OR email as the identifier, matching Chowdeck.
// -----------------------------------------
router.post("/login", loginLimiter, async (req, res) => {
  const { identifier, email, password } = req.body;
  // Accept either field name - "identifier" going forward, but "email"
  // still works so nothing calling the old shape breaks immediately.
  const loginId = identifier || email;

  if (!loginId || !password) {
    return res
      .status(400)
      .json({ error: "Phone/email and password are required" });
  }

  try {
    const result = await db.query(
      "SELECT * FROM customers WHERE email = $1 OR phone = $1",
      [loginId],
    );
    const customer = result.rows[0];

    // Same generic error whether the identifier or password is wrong, on purpose.
    if (!customer) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      customer.password_hash,
    );
    if (!passwordMatches) {
      return res.status(401).json({ error: "Invalid credentials" });
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
