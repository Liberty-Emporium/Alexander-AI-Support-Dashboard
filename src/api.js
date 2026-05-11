const express = require("express");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");
const { requireAuth } = require("./auth");
const { sendCommand, getOnlineMachines } = require("./socket");

const router = express.Router();

// ── Client Management ────────────────────────────────────────────────────────

// List all clients
router.get("/clients", requireAuth, (req, res) => {
  const clients = db.prepare(`
    SELECT c.*,
      COUNT(m.machine_id) as machine_count,
      SUM(m.online) as online_count
    FROM clients c
    LEFT JOIN machines m ON m.client_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `).all();
  res.json(clients);
});

// Get single client with machines
router.get("/clients/:id", requireAuth, (req, res) => {
  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.params.id);
  if (!client) return res.status(404).json({ error: "Not found" });

  const machines = db.prepare(`
    SELECT * FROM machines WHERE client_id = ? ORDER BY last_seen DESC
  `).all(req.params.id);

  const recentEvents = db.prepare(`
    SELECT e.* FROM events e
    JOIN machines m ON e.machine_id = m.machine_id
    WHERE m.client_id = ?
    ORDER BY e.created_at DESC LIMIT 50
  `).all(req.params.id);

  res.json({ ...client, machines, recentEvents });
});

// Create client
router.post("/clients", requireAuth, (req, res) => {
  const { name, email, agent_type, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });

  const id = uuidv4();
  const install_token = uuidv4().replace(/-/g, "");

  db.prepare(`
    INSERT INTO clients (id, name, email, agent_type, install_token, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, email || null, agent_type || "hermes", install_token, notes || null);

  res.json({ id, name, install_token });
});

// Update client
router.patch("/clients/:id", requireAuth, (req, res) => {
  const { name, email, notes } = req.body || {};
  db.prepare(`
    UPDATE clients SET
      name = COALESCE(?, name),
      email = COALESCE(?, email),
      notes = COALESCE(?, notes)
    WHERE id = ?
  `).run(name || null, email || null, notes || null, req.params.id);
  res.json({ ok: true });
});

// Delete client
router.delete("/clients/:id", requireAuth, (req, res) => {
  db.prepare("DELETE FROM clients WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Link machine to client (called by liberty_agent on startup)
router.post("/clients/:id/link-machine", (req, res) => {
  const { machine_id } = req.body || {};
  const token = req.headers["x-install-token"];
  if (!machine_id || !token) return res.status(400).json({ error: "Missing fields" });

  const client = db.prepare("SELECT * FROM clients WHERE id = ? AND install_token = ?").get(req.params.id, token);
  if (!client) return res.status(401).json({ error: "Invalid token" });

  db.prepare(`
    UPDATE machines SET client_id = ? WHERE machine_id = ?
  `).run(req.params.id, machine_id);

  // If machine doesn't exist yet, create a placeholder
  db.prepare(`
    INSERT OR IGNORE INTO machines (machine_id, client_id, online)
    VALUES (?, ?, 0)
  `).run(machine_id, req.params.id);

  res.json({ ok: true });
});

// ── Machines ─────────────────────────────────────────────────────────────────

router.get("/machines", requireAuth, (req, res) => {
  const machines = db.prepare(`
    SELECT m.*, c.name as client_name
    FROM machines m
    LEFT JOIN clients c ON m.client_id = c.id
    ORDER BY m.last_seen DESC
  `).all();
  res.json(machines);
});

router.get("/machines/:id", requireAuth, (req, res) => {
  const machine = db.prepare(`
    SELECT m.*, c.name as client_name
    FROM machines m LEFT JOIN clients c ON m.client_id = c.id
    WHERE m.machine_id = ?
  `).get(req.params.id);
  if (!machine) return res.status(404).json({ error: "Not found" });

  const events = db.prepare(`
    SELECT * FROM events WHERE machine_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(req.params.id);

  const commands = db.prepare(`
    SELECT * FROM commands WHERE machine_id = ? ORDER BY sent_at DESC LIMIT 20
  `).all(req.params.id);

  res.json({ ...machine, events, commands });
});

// Send command to machine
router.post("/machines/:id/command", requireAuth, (req, res) => {
  const { cmd } = req.body || {};
  if (!cmd) return res.status(400).json({ error: "cmd required" });

  const sent = sendCommand(req.params.id, cmd);
  if (!sent) return res.status(503).json({ error: "Machine offline" });
  res.json({ ok: true, cmd });
});

// ── Events ───────────────────────────────────────────────────────────────────

router.get("/events", requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const type = req.query.type;
  const events = db.prepare(`
    SELECT e.*, m.hostname, c.name as client_name
    FROM events e
    LEFT JOIN machines m ON e.machine_id = m.machine_id
    LEFT JOIN clients c ON m.client_id = c.id
    ${type ? "WHERE e.type = ?" : ""}
    ORDER BY e.created_at DESC LIMIT ?
  `).all(...(type ? [type, limit] : [limit]));
  res.json(events);
});

// ── Stats ─────────────────────────────────────────────────────────────────────

router.get("/stats", requireAuth, (req, res) => {
  const totalClients   = db.prepare("SELECT COUNT(*) as n FROM clients").get().n;
  const totalMachines  = db.prepare("SELECT COUNT(*) as n FROM machines").get().n;
  const onlineMachines = getOnlineMachines().length;
  const errorCount24h  = db.prepare(`
    SELECT COUNT(*) as n FROM events
    WHERE type = 'error' AND created_at > datetime('now', '-24 hours')
  `).get().n;

  res.json({ totalClients, totalMachines, onlineMachines, errorCount24h });
});

module.exports = router;
