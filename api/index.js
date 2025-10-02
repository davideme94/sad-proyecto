// api/index.js
import express from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import serverless from "serverless-http";

// Cargar env en local (Vercel inyecta env en prod)
if (process.env.VERCEL !== "1") {
  const { config } = await import("dotenv");
  config();
}

// --------- Conexión Mongoose con cache global (serverless best practice)
const MONGODB_URI = process.env.MONGODB_URI || "";
if (!global._mongoose) global._mongoose = { conn: null, promise: null };
async function dbConnect() {
  if (global._mongoose.conn) return global._mongoose.conn;
  if (!global._mongoose.promise) {
    global._mongoose.promise = mongoose
      .connect(MONGODB_URI)
      .then((m) => m);
  }
  global._mongoose.conn = await global._mongoose.promise;
  return global._mongoose.conn;
}

// --------- Schemas/Models (defínelos una sola vez)
const docenteSchema = new mongoose.Schema(
  { dni: { type: String, required: true, unique: true, match: /^[0-9]{7,9}$/ },
    nombre: { type: String, required: true } },
  { timestamps: true }
);
const resolucionSchema = new mongoose.Schema(
  { docenteDni: { type: String, required: true, index: true, match: /^[0-9]{7,9}$/ },
    titulo: { type: String, required: true },
    driveUrl: { type: String, required: true },
    expediente: String, anio: Number, creadoPor: String },
  { timestamps: true }
);
const acuseSchema = new mongoose.Schema(
  { docenteDni: { type: String, required: true, index: true },
    resolucionId: { type: mongoose.Schema.Types.ObjectId, ref: "Resolucion", required: true, index: true },
    nombreCompleto: { type: String, required: true },
    email: { type: String, required: true, match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
    acepto: { type: Boolean, required: true },
    textoLegal: { type: String, required: true },
    ipHash: String, userAgent: String, firmadoEn: { type: Date, default: Date.now } },
  { timestamps: true }
);
const usuarioSchema = new mongoose.Schema(
  { email: { type: String, unique: true }, passHash: String },
  { timestamps: true }
);

// Evitar recompilar modelos en caliente
const Docente = mongoose.models.Docente || mongoose.model("Docente", docenteSchema);
const Resolucion = mongoose.models.Resolucion || mongoose.model("Resolucion", resolucionSchema);
const Acuse = mongoose.models.Acuse || mongoose.model("Acuse", acuseSchema);
const Usuario = mongoose.models.Usuario || mongoose.model("Usuario", usuarioSchema);

// --------- App Express
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(helmet());
app.use(rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true }));

// CORS no es necesario si front y api están en mismo dominio (Vercel).
// Si querés permitir orígenes externos, podés agregar cors() aquí.

// Seed admin (se ejecuta bajo demanda en cada invocación)
async function ensureAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const pass = process.env.ADMIN_PASSWORD;
  const found = await Usuario.findOne({ email });
  if (!found) {
    const passHash = await bcrypt.hash(pass, 10);
    await Usuario.create({ email, passHash });
    console.log("Admin creado:", email);
  }
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
}

// Conectar DB antes de cada request
app.use(async (_req, _res, next) => { await dbConnect(); await ensureAdmin(); next(); });

// ---- Rutas
app.get("/api", (_req, res) => res.json({ ok: true }));

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const user = await Usuario.findOne({ email });
  if (!user) return res.status(401).json({ error: "Credenciales" });
  const ok = await bcrypt.compare(password, user.passHash);
  if (!ok) return res.status(401).json({ error: "Credenciales" });
  const token = jwt.sign({ sub: user._id, email }, process.env.JWT_SECRET, { expiresIn: "1d" });
  res.json({ token, email });
});

app.post("/api/admin/docentes", auth, async (req, res) => {
  const { dni, nombre } = req.body || {};
  if (!/^[0-9]{7,9}$/.test(dni) || !nombre) return res.status(400).json({ error: "Datos inválidos" });
  const doc = await Docente.findOneAndUpdate({ dni }, { nombre }, { upsert: true, new: true });
  res.json(doc);
});

app.post("/api/admin/resoluciones", auth, async (req, res) => {
  const { docenteDni, titulo, driveUrl, expediente, anio } = req.body || {};
  if (!/^[0-9]{7,9}$/.test(docenteDni) || !titulo || !driveUrl) return res.status(400).json({ error: "Datos inválidos" });
  const exists = await Docente.findOne({ dni: docenteDni });
  if (!exists) return res.status(404).json({ error: "Docente no existe" });
  const r = await Resolucion.create({ docenteDni, titulo, driveUrl, expediente, anio, creadoPor: req.user.email });
  res.status(201).json(r);
});

app.get("/api/admin/resoluciones", auth, async (_req, res) => {
  const list = await Resolucion.find().sort({ createdAt: -1 }).lean();
  res.json(list);
});
app.get("/api/admin/acuses", auth, async (_req, res) => {
  const list = await Acuse.find().sort({ firmadoEn: -1 }).lean();
  res.json(list);
});
app.get("/api/admin/resoluciones/:id/acuses", auth, async (req, res) => {
  const list = await Acuse.find({ resolucionId: req.params.id }).sort({ firmadoEn: -1 }).lean();
  res.json(list);
});

app.get("/api/public/buscar", async (req, res) => {
  const dni = String(req.query.dni || "");
  if (!/^[0-9]{7,9}$/.test(dni)) return res.status(400).json({ error: "DNI inválido" });
  const docente = await Docente.findOne({ dni });
  const resoluciones = await Resolucion.find({ docenteDni: dni }).sort({ createdAt: -1 });
  res.json({ nombre: docente?.nombre || null, dni, resoluciones });
});

app.post("/api/public/acuse", async (req, res) => {
  const { docenteDni, resolucionId, nombreCompleto, email, acepto, textoLegal } = req.body || {};
  if (!/^[0-9]{7,9}$/.test(docenteDni) || !resolucionId || !nombreCompleto ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || acepto !== true || !textoLegal) {
    return res.status(400).json({ error: "Datos inválidos" });
  }
  const resol = await Resolucion.findById(resolucionId);
  if (!resol || resol.docenteDni !== docenteDni)
    return res.status(404).json({ error: "Resolución no encontrada" });

  const ip = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim();
  const ipHash = crypto.createHash("sha256").update(ip).digest("hex");

  const acuse = await Acuse.create({
    docenteDni, resolucionId, nombreCompleto, email, acepto: true, textoLegal,
    ipHash, userAgent: req.headers["user-agent"] || ""
  });

  res.status(201).json({ ok: true, acuseId: acuse._id, driveUrl: resol.driveUrl });
});

// Export serverless handler
export default serverless(app);
