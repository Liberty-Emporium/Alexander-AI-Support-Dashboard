require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const path = require("path");

const { seedAdminIfNeeded, loginRoute, requireAuth } = require("./auth");
const { initSocket } = require("./socket");
const api = require("./api");

const app = express();
const server = http.createServer(app);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post("/api/login", loginRoute);

// ── API ───────────────────────────────────────────────────────────────────────
app.use("/api", api);

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── Routes ────────────────────────────────────────────────────────────────────
// Public — no auth
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/landing.html"));
});
app.get("/landing", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/landing.html"));
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
initSocket(server);

// ── Boot ──────────────────────────────────────────────────────────────────────
seedAdminIfNeeded();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[alexander-ai] Dashboard running on port ${PORT}`);
});
