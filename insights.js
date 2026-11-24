const { creds } = require("./helpers");

function isPublicKey(value) {
  if (!value) return false;
  if (value.startsWith("sb_publishable_")) return true;

  try {
    const segments = value.split(".");
    if (segments.length !== 3) return false;
    const claims = JSON.parse(Buffer.from(segments[1], "base64url"));
    return claims.role === "anon";
  } catch {
    return false;
  }
}

module.exports = (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método não permitido." });
  }

  const { supabaseUrl, anonKey } = creds();
  const config = supabaseUrl && isPublicKey(anonKey)
    ? { supabaseUrl, anonKey }
    : null;

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(`window.reelsManagerConfig = ${JSON.stringify(config)};\n`);
};
