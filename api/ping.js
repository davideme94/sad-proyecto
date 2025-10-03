// api/ping.js
export const config = { runtime: "nodejs" };

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ ok: true, ts: Date.now(), path: req.url });
}
