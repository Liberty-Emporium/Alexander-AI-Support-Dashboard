const { Server } = require("socket.io");
const db = require("./db");

// Map: machine_id -> socket
const activeSockets = new Map();

function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ["websocket", "polling"],
  });

  io.on("connection", (socket) => {
    const machineId = socket.handshake.query.session_id;
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

    // ── machine_info ────────────────────────────────────────────────────
    socket.on("machine_info", (info) => {
      if (!info || typeof info !== "object") return;
      const mid = info.machine_id || machineId;

      // Upsert machine row
      db.prepare(`
        INSERT INTO machines (machine_id, hostname, os, os_release, architecture,
          agent_type, agent_version, hermes_version, docker_container,
          disk_total_gb, disk_free_gb, last_seen, connected_at, online)
        VALUES (@machine_id, @hostname, @os, @os_release, @architecture,
          @agent_type, @agent_version, @hermes_version, @docker_container,
          @disk_total_gb, @disk_free_gb, datetime('now'), @connected_at, 1)
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
          last_seen = datetime('now'),
          online = 1
      `).run({
        machine_id:       mid,
        hostname:         info.hostname || null,
        os:               info.os || null,
        os_release:       info.os_release || null,
        architecture:     info.architecture || null,
        agent_type:       info.agent_type || null,
        agent_version:    info.agent_version || null,
        hermes_version:   info.hermes_version || null,
        docker_container: info.docker_container || null,
        disk_total_gb:    info.disk_total_gb || null,
        disk_free_gb:     info.disk_free_gb || null,
        connected_at:     info.connected_at || new Date().toISOString(),
      });

      console.log(`[socket] machine_info from ${mid} (${info.hostname})`);
    });

    // ── error report ────────────────────────────────────────────────────
    socket.on("error_report", (data) => {
      db.prepare(`
        INSERT INTO events (machine_id, type, message, data)
        VALUES (?, 'error', ?, ?)
      `).run(machineId, data?.message || "Unknown error", JSON.stringify(data));
      console.log(`[socket] ERROR from ${machineId}: ${data?.message}`);
    });

    // ── command result ───────────────────────────────────────────────────
    socket.on("command_result", (data) => {
      db.prepare(`
        UPDATE commands
        SET output = ?, returncode = ?, timed_out = ?, replied_at = datetime('now')
        WHERE machine_id = ? AND id = (
          SELECT id FROM commands WHERE machine_id = ? ORDER BY id DESC LIMIT 1
        )
      `).run(data.output, data.returncode, data.timed_out ? 1 : 0, machineId, machineId);
      console.log(`[socket] cmd_result from ${machineId} rc=${data.returncode}`);
    });

    // ── pong ─────────────────────────────────────────────────────────────
    socket.on("pong_agent", (data) => {
      db.prepare(`UPDATE machines SET last_seen = datetime('now') WHERE machine_id = ?`).run(machineId);
    });

    // ── disconnect ───────────────────────────────────────────────────────
    socket.on("disconnect", () => {
      activeSockets.delete(machineId);
      db.prepare(`UPDATE machines SET online = 0, last_seen = datetime('now') WHERE machine_id = ?`).run(machineId);
      db.prepare(`INSERT INTO events (machine_id, type, message) VALUES (?, 'disconnect', 'Agent disconnected')`).run(machineId);
      console.log(`[socket] -DISCONNECT ${machineId}`);
    });
  });

  return io;
}

// Send a command to a specific machine
function sendCommand(machineId, cmd) {
  const socket = activeSockets.get(machineId);
  if (!socket) return false;

  // Save command record
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
