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
const adminAuthRouter = require("./routes/adminAuth");
const adminDashboardRouter = require("./routes/adminDashboard");
const adminOrdersRouter = require("./routes/adminOrders");
const adminVendorsRouter = require("./routes/adminVendors");
const adminCustomersRouter = require("./routes/adminCustomers");
const adminTransactionsRouter = require("./routes/adminTransactions");
const adminManagementRouter = require("./routes/adminManagement");

const app = express();

// Render puts a proxy in front of this server. Without this setting, every
// visitor appears to have the same IP address, so the rate limiter treats
// all users as one person.
app.set("trust proxy", 1);

// --- CORS ---
// ALLOWED_ORIGINS is a comma-separated list of website addresses that are
// allowed to call this API from a browser, e.g.
//   ALLOWED_ORIGINS=https://my-vendor-site.com,https://my-admin-site.com
// Requests with no Origin header (the mobile app, curl, Paystack's servers)
// are not affected - CORS is only enforced by web browsers.
//
// If ALLOWED_ORIGINS is missing, browsers are BLOCKED by default. The only
// exception is local development (NODE_ENV is not "production"), where
// http://localhost:<any port> is allowed so you can test on your computer.
const isProduction = process.env.NODE_ENV === "production";

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const localhostPattern = /^http:\/\/localhost:\d+$/;

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (
      allowedOrigins.length === 0 &&
      !isProduction &&
      localhostPattern.test(origin)
    ) {
      return callback(null, true);
    }
    callback(new Error("Not allowed by CORS"));
  },
};

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

// --- Admin routes (all admin-only, enforced server-side by requireAdminAuth) ---
app.use("/api/admin/auth", adminAuthRouter);
app.use("/api/admin/dashboard", adminDashboardRouter);
app.use("/api/admin/orders", adminOrdersRouter);
app.use("/api/admin/vendors", adminVendorsRouter);
app.use("/api/admin/customers", adminCustomersRouter);
app.use("/api/admin/transactions", adminTransactionsRouter);
app.use("/api/admin/admins", adminManagementRouter);

// A simple "is the server alive" check
app.get("/", (req, res) => {
  res.json({ message: "Vendor Dashboard API is running" });
});

// Catches errors from any route. A website that isn't allowed by CORS gets a
// clear 403; anything else gets a safe generic message with no technical details.
app.use((err, req, res, next) => {
  if (err && err.message === "Not allowed by CORS") {
    return res
      .status(403)
      .json({ error: "This website is not allowed to use this API" });
  }
  const status = err.status || err.statusCode || 500;
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: "Invalid request" });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
