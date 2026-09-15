// services/otpService.js
// Generates, sends, and verifies OTP codes for the customer signup flow
// in routes/customerAuth.js.
//
// IMPORTANT: this only ever runs at all if OTP_ENABLED=true (see
// customerAuth.js). With it left at the default "false", none of these
// functions are called - customer signup just creates the account
// immediately, same as today. This file existing is still required
// though, because require("../services/otpService") happens the
// instant the server boots, regardless of whether OTP is turned on.
//
// SENDING: no SMS/email provider is wired up yet. Until you configure
// one, the code is printed to your server logs (visible in Render's
// Logs tab) instead of being texted/emailed - fine for you to test the
// flow yourself, NOT fine to actually launch to real customers, since
// they'd never receive their code. See sendCode() below for exactly
// where a real provider (Termii for SMS, Resend for email) plugs in.
//
// Requires an `otp_verifications` table - see
// migrations/005_otp_verifications.sql. If that table doesn't exist yet,
// these functions will error when actually called, but that only
// matters once you set OTP_ENABLED=true.

const crypto = require("crypto");
const db = require("../db");

const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = 10;
const OTP_CHANNEL = (process.env.OTP_CHANNEL || "sms").toLowerCase();
const RESEND_API_KEY = process.env.RESEND_API_KEY;

function generateCode() {
  // Zero-padded so it's always 6 digits, e.g. "042917" not "42917".
  return crypto
    .randomInt(0, 10 ** OTP_LENGTH)
    .toString()
    .padStart(OTP_LENGTH, "0");
}

async function sendCode(phone, email, code) {
  if (OTP_CHANNEL === "email") {
    if (!RESEND_API_KEY) {
      console.warn(
        `⚠️  OTP for ${email}: ${code} — RESEND_API_KEY is not set, so this ` +
          `was NOT actually emailed. Printed here so you can test the flow yourself.`,
      );
      return;
    }
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "QuickBite <onboarding@resend.dev>", // replace with your verified sending domain
        to: email,
        subject: "Your verification code",
        text: `Your verification code is ${code}. It expires in ${OTP_EXPIRY_MINUTES} minutes.`,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to send verification email: ${body}`);
    }
    return;
  }

  // SMS path - no provider wired up. Termii is the common choice for
  // Nigerian numbers; this is where that call would go once you have
  // an account and API key for one.
  console.warn(
    `⚠️  OTP for ${phone}: ${code} — no SMS provider is configured, so this ` +
      `was NOT actually texted. Printed here so you can test the flow yourself.`,
  );
}

// Called by routes/customerAuth.js at signup (and resend). Stores the
// code + the pending signup payload (so the customer row isn't created
// until they actually verify), then sends it.
async function issueOtp(phone, email, purpose, pendingPayload) {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  await db.query(
    `INSERT INTO otp_verifications (phone, purpose, code, pending_payload, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [phone, purpose, code, JSON.stringify(pendingPayload), expiresAt],
  );

  await sendCode(phone, email, code);
}

// Called by routes/customerAuth.js at /signup/verify. Returns the
// pending_payload (so the caller can create the real customer row) if
// the code is correct and not expired/already used, otherwise throws a
// friendly, specific error.
async function verifyOtp(phone, purpose, code) {
  const result = await db.query(
    `SELECT * FROM otp_verifications
     WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [phone, purpose],
  );
  const row = result.rows[0];

  if (!row) return null; // no pending signup - caller treats this as "start again"

  if (new Date(row.expires_at) < new Date()) {
    throw Object.assign(
      new Error("This code has expired - please request a new one"),
      { statusCode: 400 },
    );
  }
  if (row.code !== code) {
    throw Object.assign(new Error("Incorrect verification code"), {
      statusCode: 400,
    });
  }

  await db.query(
    `UPDATE otp_verifications SET consumed_at = NOW() WHERE id = $1`,
    [row.id],
  );

  return row.pending_payload;
}

module.exports = { issueOtp, verifyOtp };
