const { Server } = require("socket.io");
const db = require("./db");

// Map: machine_id -> socket  (customer agents)
const activeSockets = new Map();

// Set of all admin browser sockets
const adminSockets = new Set();

function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ["websocket", "polling"],
  });

  io.on("connection", (socket) => {
    const machineId = socket.handshake.query.session_id;
    const isAdmin   = socket.handshake.query.admin === "1";

    // ── Admin browser connections ─────────────────────────────────────────
    if (isAdmin) {
      adminSockets.add(socket);
      console.log(`[socket] +ADMIN   (total=${adminSockets.size})`);

      socket.on("disconnect", () => {
        adminSockets.delete(socket);
        console.log(`[socket] -ADMIN   (total=${adminSockets.size})`);
      });
      return;
    }

    // ── Agent (customer machine) connections ──────────────────────────────
    if (!machineId) { socket.disconnect(); return; }

    activeSockets.set(machineId, socket);
    console.log(`[socket] +CONNECT  ${machineId}`);

    // Mark online
    db.prepare(`
      UPDATE machines SET online = 1, last_seen = datetime('now')
      WHERE machine_id = ?
    `).run(machineId);

    // Log connect event
    db.prepare(`
      INSERT INTO events (machine_id, type, message)
      VALUES (?, 'connect', 'Agent connected')
    `).run(machineId);

    // Notify admins
    broadcast({ type: "machine_online", machine_id: machineId });

    // ── machine_info ──────────────────────────────────────────────────────
    socket.on("machine_info", (info) => {
      if (!info || typeof info !== "object") return;
      const mid = info.machine_id || machineId;

      db.prepare(`
        INSERT INTO machines (machine_id, hostname, os, os_release, architecture,
          agent_type, agent_version, hermes_version, docker_container,
          disk_total_gb, disk_free_gb,
          tailscale_ip, tailscale_connected,
          last_seen, connected_at, online)
        VALUES (@machine_id, @hostname, @os, @os_release, @architecture,
          @agent_type, @agent_version, @hermes_version, @docker_container,
          @disk_total_gb, @disk_free_gb,
          @tailscale_ip, @tailscale_connected,
          datetime('now'), @connected_at, 1)
        ON CONFLICT(machine_id) DO UPDATE SET
          hostname = excluded.hostname,
          os = excluded.os,
          os_release = excluded.os_release,
          agent_type = excluded.agent_type,
          agent_version = excluded.agent_version,
          hermes_version = excluded.hermes_version,
          docker_container = excluded.docker_container,
          disk_total_gb = excluded.disk_total_gb,
          disk_free_gb = excluded.disk_free_gb,
          tailscale_ip = excluded.tailscale_ip,
          tailscale_connected = excluded.tailscale_connected,
          last_seen = datetime('now'),
          online = 1
      `).run({
        machine_id:          mid,
        hostname:            info.hostname || null,
        os:                  info.os || null,
        os_release:          info.os_release || null,
        architecture:        info.architecture || null,
        agent_type:          info.agent_type || null,
        agent_version:       info.agent_version || null,
        hermes_version:      info.hermes_version || null,
        docker_container:    info.docker_container || null,
        disk_total_gb:       info.disk_total_gb || null,
        disk_free_gb:        info.disk_free_gb || null,
        tailscale_ip:        info.tailscale_ip || null,
        tailscale_connected: info.tailscale_connected ? 1 : 0,
        connected_at:        info.connected_at || new Date().toISOString(),
      });

      console.log(`[socket] machine_info from ${mid} (${info.hostname}) ts=${info.tailscale_ip || 'none'}`);

      // Push updated machine info to admin browsers (so Tailscale badge updates live)
      broadcast({
        type:               "machine_info_updated",
        machine_id:         mid,
        tailscale_ip:       info.tailscale_ip || null,
        tailscale_connected: info.tailscale_connected || false,
        hostname:           info.hostname || null,
        agent_version:      info.agent_version || null,
      });
    });

    // ── error report ──────────────────────────────────────────────────────
    socket.on("error_report", (data) => {
      db.prepare(`
        INSERT INTO events (machine_id, type, message, data)
        VALUES (?, 'error', ?, ?)
      `).run(machineId, data?.message || "Unknown error", JSON.stringify(data));
      console.log(`[socket] ERROR from ${machineId}: ${data?.message}`);
      broadcast({ type: "error_report", machine_id: machineId, message: data?.message });
    });

    // ── command result — push to all admin browsers in real-time ──────────
    socket.on("command_result", (data) => {
      db.prepare(`
        UPDATE commands
        SET output = ?, returncode = ?, timed_out = ?, replied_at = datetime('now')
        WHERE machine_id = ? AND id = (
          SELECT id FROM commands WHERE machine_id = ? ORDER BY id DESC LIMIT 1
        )
      `).run(data.output, data.returncode, data.timed_out ? 1 : 0, machineId, machineId);

      console.log(`[socket] cmd_result from ${machineId} rc=${data.returncode}`);

      // Push to every open admin browser immediately
      broadcast({
        type:       "command_result",
        machine_id: machineId,
        cmd:        data.cmd,
        cmd_id:     data.cmd_id,
        output:     data.output,
        returncode: data.returncode,
        timed_out:  data.timed_out,
      });
    });

    // ── pong ──────────────────────────────────────────────────────────────
    socket.on("pong_agent", (data) => {
      db.prepare(`UPDATE machines SET last_seen = datetime('now') WHERE machine_id = ?`).run(machineId);
    });

    // ── disconnect ────────────────────────────────────────────────────────
    socket.on("disconnect", () => {
      activeSockets.delete(machineId);
      db.prepare(`UPDATE machines SET online = 0, last_seen = datetime('now') WHERE machine_id = ?`).run(machineId);
      db.prepare(`INSERT INTO events (machine_id, type, message) VALUES (?, 'disconnect', 'Agent disconnected')`).run(machineId);
      console.log(`[socket] -DISCONNECT ${machineId}`);
      broadcast({ type: "machine_offline", machine_id: machineId });
    });
  });

  return io;
}

// Broadcast a message to all connected admin browsers
function broadcast(payload) {
  for (const s of adminSockets) {
    try { s.emit("admin_event", payload); } catch (_) {}
  }
}

// Send a command to a specific machine
function sendCommand(machineId, cmd) {
  const socket = activeSockets.get(machineId);
  if (!socket) return false;

  const result = db.prepare(`
    INSERT INTO commands (machine_id, cmd) VALUES (?, ?)
  `).run(machineId, cmd);

  socket.emit("echo_command", { cmd, cmd_id: String(result.lastInsertRowid) });
  return true;
}

function getOnlineMachines() {
  return [...activeSockets.keys()];
}

module.exports = { initSocket, sendCommand, getOnlineMachines };
