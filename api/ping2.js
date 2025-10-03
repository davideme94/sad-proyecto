// api/ping2.js
export const config = { runtime: "nodejs" };
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ ok: true, ts: Date.now(), where: "ping2 (filesystem function)" });
}
