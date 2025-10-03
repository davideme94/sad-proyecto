// api/index.js
import express from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import serverless from "serverless-http";
import path from "path";
import { fileURLToPath } from "url";

if (process.env.VERCEL !== "1") {
  const { config } = await import("dotenv");
  config();
}

const MONGODB_URI = (process.env.MONGODB_URI || "").trim();

// ---------- Conexión Mongo (timeout corto + IPv4) ----------
if (!global._mongoose) global._mongoose = { conn: null, promise: null };
let LAST_DB_ERROR = null;

async function dbConnect() {
  if (global._mongoose.conn) return global._mongoose.conn;
  if (!MONGODB_URI) throw new Error("MONGODB_URI not set");
  if (!global._mongoose.promise) {
    global._mongoose.promise = mongoose
      .connect(MONGODB_URI, {
        family: 4,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 8000,
      })
      .then((m) => m)
      .catch((err) => {
        global._mongoose.promise = null;
        LAST_DB_ERROR = err;
        throw err;
      });
  }
  global._mongoose.conn = await global._mongoose.promise;
  return global._mongoose.conn;
}

const withTimeout = (p, ms, name = "timeout") =>
  Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(name)), ms))]);

// --------- Schemas ---------
const docenteSchema = new mongoose.Schema(
  { dni: { type: String, required: true, unique: true, match: /^[0-9]{7,9}$/ }, nombre: { type: String, required: true } },
  { timestamps: true }
);

const NIVELES = ["PRIMARIA", "SECUNDARIA", "TECNICA", "EDUC. FISICA", "ARTISTICA", "PSICOLOGIA", "ADULTOS Y CENS"];

const resolucionSchema = new mongoose.Schema(
  { docenteDni: { type: String, index: true, match: /^[0-9]{7,9}$/ }, titulo: { type: String, required: true }, driveUrl: { type: String, required: true }, expediente: String, nivel: { type: String, enum: NIVELES, default: null }, creadoPor: String },
  { timestamps: true }
);

const vinculoSchema = new mongoose.Schema(
  { docenteDni: { type: String, required: true, match: /^[0-9]{7,9}$/ }, resolucionId: { type: mongoose.Schema.Types.ObjectId, ref: "Resolucion", required: true } },
  { timestamps: true }
);
vinculoSchema.index({ docenteDni: 1, resolucionId: 1 }, { unique: true });

const acuseSchema = new mongoose.Schema(
  {
    docenteDni: { type: String, required: true, index: true },
    resolucionId: { type: mongoose.Schema.Types.ObjectId, ref: "Resolucion", required: true, index: true },
    nombreCompleto: { type: String, required: true },
    email: { type: String, required: true, match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
    acepto: { type: Boolean, required: true },
    textoLegal: { type: String, required: true },
    ipHash: String,
    userAgent: String,
    firmadoEn: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const usuarioSchema = new mongoose.Schema({ email: { type: String, unique: true }, passHash: String }, { timestamps: true });

const Docente = mongoose.models.Docente || mongoose.model("Docente", docenteSchema);
const Resolucion = mongoose.models.Resolucion || mongoose.model("Resolucion", resolucionSchema);
const Vinculo = mongoose.models.Vinculo || mongoose.model("Vinculo", vinculoSchema);
const Acuse = mongoose.models.Acuse || mongoose.model("Acuse", acuseSchema);
const Usuario = mongoose.models.Usuario || mongoose.model("Usuario", usuarioSchema);

// --------- App ---------
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(helmet({ contentSecurityPolicy: process.env.VERCEL === "1" ? undefined : false }));
app.use(rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true }));

// --- ENDPOINTS sin DB (antes del middleware) ---
app.get(["/api/ping", "/ping"], (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.get(["/api/health", "/health"], (req, res) => {
  const ok = mongoose.connection?.readyState === 1;
  const state = mongoose.connection?.readyState ?? 0;
  if (req.query.verbose === "1") {
    return res.json({
      ok,
      state,
      error: LAST_DB_ERROR
        ? { name: LAST_DB_ERROR.name, message: String(LAST_DB_ERROR.message).slice(0, 400), code: LAST_DB_ERROR.code ?? null }
        : null,
    });
  }
  res.json({ ok, state });
});

// --------- Helpers ---------
async function ensureAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const pass = process.env.ADMIN_PASSWORD;
  if (!email || !pass) return;
  const found = await Usuario.findOne({ email });
  if (!found) {
    const passHash = await bcrypt.hash(pass, 10);
    await Usuario.create({ email, passHash });
    console.log("Admin creado:", email);
  }
}
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  theToken: {
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: "No token" });
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
      break theToken;
    } catch {
      return res.status(401).json({ error: "Token inválido" });
    }
  }
  next();
}

// --- Middleware de DB: saltea ping/health (ignora query y trailing slash) ---
app.use(async (req, res, next) => {
  const raw = req.originalUrl || req.url || "";
  const pathOnly = raw.split("?")[0].replace(/\/+$/, ""); // sin query y sin barra final
  const BYPASS = new Set(["/api/health", "/health", "/api/ping", "/ping"]);
  if (BYPASS.has(pathOnly)) return next();

  try {
    await withTimeout(dbConnect(), 4500, "DB_CONNECT_TIMEOUT");
    await ensureAdmin();
    next();
  } catch (e) {
    console.error("DB error:", e?.message || e);
    LAST_DB_ERROR = e;
    return res.status(503).json({ error: "DB_UNAVAILABLE" });
  }
});

// ---- Auth
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const user = await Usuario.findOne({ email });
  if (!user) return res.status(401).json({ error: "Credenciales" });
  const ok = await bcrypt.compare(password, user.passHash);
  if (!ok) return res.status(401).json({ error: "Credenciales" });
  const token = jwt.sign({ sub: user._id, email }, process.env.JWT_SECRET, { expiresIn: "1d" });
  res.json({ token, email });
});

// ---- Docentes CRUD + búsqueda
app.get("/api/admin/docentes", auth, async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  const filter = q ? { $or: [{ dni: new RegExp(q, "i") }, { nombre: new RegExp(q, "i") }] } : {};
  const list = await Docente.find(filter).sort({ nombre: 1 }).lean();
  res.json(list);
});
app.post("/api/admin/docentes", auth, async (req, res) => {
  const { dni, nombre } = req.body || {};
  if (!/^[0-9]{7,9}$/.test(dni) || !nombre) return res.status(400).json({ error: "Datos inválidos" });
  const existing = await Docente.findOne({ dni });
  if (existing) {
    if (existing.nombre !== nombre) { existing.nombre = nombre; await existing.save(); return res.json({ ...existing.toObject(), updated: true }); }
    return res.json({ ...existing.toObject(), alreadyExisted: true });
  }
  const created = await Docente.create({ dni, nombre });
  res.status(201).json({ ...created.toObject(), created: true });
});
app.patch("/api/admin/docentes/:dni", auth, async (req, res) => {
  const { nombre } = req.body || {};
  const doc = await Docente.findOneAndUpdate({ dni: req.params.dni }, { nombre }, { new: true });
  if (!doc) return res.status(404).json({ error: "No encontrado" });
  res.json(doc);
});
app.delete("/api/admin/docentes/:dni", auth, async (req, res) => {
  const dni = req.params.dni;
  const doc = await Docente.findOneAndDelete({ dni });
  if (!doc) return res.status(404).json({ error: "No encontrado" });
  await Vinculo.deleteMany({ docenteDni: dni });
  res.json({ ok: true, deleted: true });
});

// ---- Resoluciones CRUD
app.get("/api/admin/resoluciones", auth, async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  const filter = q ? { titulo: new RegExp(q, "i") } : {};
  const list = await Resolucion.find(filter).sort({ createdAt: -1 }).lean();
  res.json(list);
});
app.post("/api/admin/resoluciones", auth, async (req, res) => {
  const { docenteDni, titulo, driveUrl, expediente, nivel } = req.body || {};
  if (!titulo || !driveUrl) return res.status(400).json({ error: "Datos inválidos" });
  if (docenteDni) {
    const exists = await Docente.findOne({ dni: docenteDni });
    if (!exists) return res.status(404).json({ error: "Docente no existe" });
  }
  if (nivel && !NIVELES.includes(nivel)) return res.status(400).json({ error: "Nivel inválido" });
  const dup = await Resolucion.findOne({ titulo, driveUrl });
  if (dup) return res.json({ ...dup.toObject(), alreadyExisted: true });
  const r = await Resolucion.create({ docenteDni: docenteDni || null, titulo, driveUrl, expediente, nivel, creadoPor: req.user.email });
  res.status(201).json({ ...r.toObject(), created: true });
});
app.patch("/api/admin/resoluciones/:id", auth, async (req, res) => {
  const updates = (({ titulo, driveUrl, expediente, nivel }) => ({ titulo, driveUrl, expediente, nivel }))(req.body || {});
  if (updates.nivel && !NIVELES.includes(updates.nivel)) return res.status(400).json({ error: "Nivel inválido" });
  Object.keys(updates).forEach((k) => updates[k] === undefined && delete updates[k]);
  const r = await Resolucion.findByIdAndUpdate(req.params.id, updates, { new: true });
  if (!r) return res.status(404).json({ error: "No encontrada" });
  res.json(r);
});
app.delete("/api/admin/resoluciones/:id", auth, async (req, res) => {
  const r = await Resolucion.findByIdAndDelete(req.params.id);
  if (!r) return res.status(404).json({ error: "No encontrada" });
  await Vinculo.deleteMany({ resolucionId: req.params.id });
  res.json({ ok: true, deleted: true });
});

// ---- Vínculos
app.post("/api/admin/vinculos", auth, async (req, res) => {
  const { resolucionId, dnis } = req.body || {};
  if (!resolucionId || !Array.isArray(dnis) || dnis.length === 0) return res.status(400).json({ error: "Datos inválidos" });
  const validDnis = dnis.filter((d) => /^[0-9]{7,9}$/.test(String(d)));
  const docentes = await Docente.find({ dni: { $in: validDnis } }).lean();
  const existentes = new Set(docentes.map((d) => d.dni));
  const noEncontrados = validDnis.filter((d) => !existentes.has(d));
  const ops = validDnis.filter((d) => existentes.has(d)).map((dni) => ({
    updateOne: { filter: { docenteDni: dni, resolucionId }, update: { $setOnInsert: { docenteDni: dni, resolucionId } }, upsert: true },
  }));
  if (ops.length) await Vinculo.bulkWrite(ops);
  res.json({ ok: true, vinculados: ops.length, ignorados: noEncontrados });
});
app.get("/api/admin/vinculos/:resolucionId", auth, async (req, res) => {
  const list = await Vinculo.find({ resolucionId: req.params.resolucionId }).lean();
  res.json(list);
});
app.delete("/api/admin/vinculos", auth, async (req, res) => {
  const { resolucionId, docenteDni } = req.body || {};
  if (!resolucionId || !docenteDni) return res.status(400).json({ error: "Datos inválidos" });
  await Vinculo.deleteOne({ resolucionId, docenteDni });
  res.json({ ok: true, deleted: true });
});

// ---- Admin: acuses
app.get("/api/admin/acuses", auth, async (_req, res) => {
  const list = await Acuse.find().sort({ firmadoEn: -1 }).lean();
  res.json(list);
});

// ---- Pública
app.get("/api/public/buscar", async (req, res) => {
  const dni = String(req.query.dni || "");
  if (!/^[0-9]{7,9}$/.test(dni)) return res.status(400).json({ error: "DNI inválido" });

  try {
    const docente = await Docente.findOne({ dni });

    const directas = await Resolucion.find({ docenteDni: dni }).lean();
    const vincs = await Vinculo.find({ docenteDni: dni }).lean();
    const ids = vincs.map((v) => v.resolucionId);
    const vinculadas = ids.length ? await Resolucion.find({ _id: { $in: ids } }).lean() : [];

    const all = [...directas, ...vinculadas];
    const map = new Map(all.map((r) => [String(r._id), r]));
    const resoluciones = Array.from(map.values()).sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));

    const acuses = await Acuse.find({
      docenteDni: dni,
      resolucionId: { $in: resoluciones.map((r) => r._id) },
    })
      .select({ resolucionId: 1 })
      .lean();

    const yaIds = new Set(acuses.map((a) => String(a.resolucionId)));
    const resolucionesMarcadas = resoluciones.map((r) => ({
      ...r,
      yaAcuso: yaIds.has(String(r._id)),
    }));

    res.json({ nombre: docente?.nombre || null, dni, resoluciones: resolucionesMarcadas });
  } catch (e) {
    console.error("buscar error:", e?.message || e);
    res.status(503).json({ error: "DB_UNAVAILABLE" });
  }
});

// ---- Front local
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
if (process.env.VERCEL !== "1") {
  app.use(express.static(path.resolve(__dirname, "..")));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.resolve(__dirname, "..", "index.html"));
  });
}

if (process.env.VERCEL !== "1") {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("API on http://localhost:" + port));
}

// Runtime para Latest Build System
export const config = { runtime: "nodejs" };
export default serverless(app);
