const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./db");

const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";
const JWT_EXPIRES = "24h";

function seedAdminIfNeeded() {
  const admin = db.prepare("SELECT id FROM admins WHERE username = ?").get("jay");
  if (!admin) {
    const password = process.env.ADMIN_PASSWORD || "alexander2024";
    const hash = bcrypt.hashSync(password, 10);
    db.prepare("INSERT INTO admins (username, password) VALUES (?, ?)").run("jay", hash);
    console.log("[auth] Default admin created: jay / (see ADMIN_PASSWORD env)");
  }
}

function loginRoute(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Missing credentials" });

  const admin = db.prepare("SELECT * FROM admins WHERE username = ?").get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign({ id: admin.id, username: admin.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  res.json({ token, username: admin.username });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.cookies?.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

module.exports = { seedAdminIfNeeded, loginRoute, requireAuth };
