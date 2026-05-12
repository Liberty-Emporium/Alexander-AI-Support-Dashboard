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

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post("/api/login", loginRoute);

// ── API ───────────────────────────────────────────────────────────────────────
app.use("/api", api);

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// TEMP: one-time password reset — will be removed after use
app.post("/api/reset-admin", (req, res) => {
  const { secret, password } = req.body || {};
  if (secret !== "echo-reset-2026") return res.status(403).json({ error: "nope" });
  const bcrypt = require("bcryptjs");
  const hash = bcrypt.hashSync(password, 10);
  db.prepare("UPDATE admins SET password = ? WHERE username = 'jay'").run(hash);
  res.json({ ok: true, message: "Password updated" });
});

// ── Named routes (must come before express.static to avoid index.html default) ─
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/landing.html"));
});
app.get("/landing", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/landing.html"));
});
app.get("/install", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/install.html"));
});
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// ── Static assets (JS, CSS, images, etc.) ────────────────────────────────────
// index: false prevents express.static from auto-serving index.html for /
app.use(express.static(path.join(__dirname, "../public"), { index: false }));

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
