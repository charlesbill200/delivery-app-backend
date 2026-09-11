// server.js
// This is the file you run: "npm run dev"
// It starts the web server and wires up all the routes.

const express = require("express");
const cors = require("cors");
require("dotenv").config();

const menuItemsRouter = require("./routes/menuItems");
const ordersRouter = require("./routes/orders");
const authRouter = require("./routes/auth");
const publicRouter = require("./routes/publicRoutes"); // remember: your file is named publicRoutes.js
const vendorProfileRouter = require("./routes/vendorProfile");
const customerAuthRouter = require("./routes/customerAuth");
const customerProfileRouter = require("./routes/customerProfile");
const vendorZoneFeesRouter = require("./routes/vendorZoneFees");
const paymentsRouter = require("./routes/payments");

const app = express();

// --- CORS ---
// ALLOWED_ORIGINS is a comma-separated list, e.g.
//   ALLOWED_ORIGINS=https://your-vendor-dashboard.com,https://your-admin.com
// The customer app is a mobile app (no browser origin), so it isn't
// affected by this - CORS only matters for browser-based clients like
// the vendor dashboard. If ALLOWED_ORIGINS isn't set (e.g. local dev),
// falls back to allowing any origin so local development doesn't break.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : null;

const corsOptions = allowedOrigins
  ? {
      origin: (origin, callback) => {
        // requests with no origin (curl, server-to-server, mobile apps)
        // are allowed through - CORS is a browser-enforced concept only
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      },
    }
  : {}; // no ALLOWED_ORIGINS set - permissive, for local dev only

// --- Middleware (things that run on EVERY request) ---
app.use(cors(corsOptions));

// The Paystack webhook MUST be mounted with a raw body parser, and BEFORE
// express.json() below - the signature check in paystackService.js needs
// the exact raw bytes Paystack signed, not a re-serialized JS object.
// (express's body parsers set an internal flag once a body has been
// read, so express.json() further down correctly skips re-parsing this
// one path instead of hanging on an already-consumed stream.)
app.use("/api/payments/webhook", express.raw({ type: "application/json" }));

app.use(express.json()); // lets us read JSON from request bodies (req.body)

// --- Routes ---
app.use("/api/auth", authRouter);
app.use("/api/public", publicRouter);
app.use("/api/menu-items", menuItemsRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/vendor", vendorProfileRouter);
app.use("/api/customer/auth", customerAuthRouter);
app.use("/api/customer", customerProfileRouter);
app.use("/api/vendor/zone-fees", vendorZoneFeesRouter);
app.use("/api/payments", paymentsRouter);

// A simple "is the server alive" check
app.get("/", (req, res) => {
  res.json({ message: "Vendor Dashboard API is running" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
