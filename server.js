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

const app = express();

// --- Middleware (things that run on EVERY request) ---
app.use(cors()); // allows your React app (different port) to call this API
app.use(express.json()); // lets us read JSON from request bodies (req.body)

// --- Routes ---
app.use("/api/auth", authRouter);
app.use("/api/public", publicRouter);
app.use("/api/menu-items", menuItemsRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/vendor", vendorProfileRouter);
app.use("/api/customer/auth", customerAuthRouter);
app.use("/api/customer", customerProfileRouter);

// A simple "is the server alive" check
app.get("/", (req, res) => {
  res.json({ message: "Vendor Dashboard API is running" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
