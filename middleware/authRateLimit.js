// middleware/authRateLimit.js
// Limits how many times an IP can hit login/signup in a window - the
// generic "Invalid email or password" error message stops an attacker
// from learning WHICH emails exist, but does nothing to stop them from
// just trying thousands of passwords against one email. This does.

const rateLimit = require("express-rate-limit");

// Login: tight limit, since a real user rarely fails login more than a
// few times in a row. 10 attempts / 15 min per IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many login attempts. Please try again in a few minutes.",
  },
});

// Signup: looser, since shared IPs (offices, campuses, carrier-grade NAT
// common on Nigerian mobile networks) could plausibly have several real
// signups in a short window. Still bounded to stop automated account
// creation. 20 / hour per IP.
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error:
      "Too many accounts created from this network. Please try again later.",
  },
});

module.exports = { loginLimiter, signupLimiter };
