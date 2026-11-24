
const { creds, db } = require("../helpers");

const API_VERSION = process.env.IG_API_VERSION || "v27.0";

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Método não permitido."
    });
  }

  const secret = process.env.CRON_SECRET;
  const authorization = req.headers.authorization || "";

  if (!secret || authorization !== `Bearer ${secret}`) {
    return res.status(401).json({
      ok: false,
      error: "Não autorizado."
    });
  }

  try {
    const config = creds();

    const rows = await db(
      "instagram_accounts?select=username,instagram_user_id,access_token,connection_status&username=eq.pamela.ruivinhart&limit=1"
    );

    const account = Array.isArray(rows) ? rows[0] : null;

    if (
      !account ||
      account.connection_status !== "connected" ||
      !account.access_token ||
      !account.instagram_user_id
    ) {
      return res.status(400).json({
        ok: false,
        error: "Conta não encontrada ou sem dados de conexão."
      });
    }

    const url = new URL(
      `https://graph.facebook.com/${API_VERSION}/${account.instagram_user_id}`
    );

    url.searchParams.set("fields", "id,username");
    url.searchParams.set("access_token", account.access_token);

    const response = await fetch(url.toString());
    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.error) {
      console.error(
        "Instagram token verification:",
        data.error?.message || "Falha na consulta."
      );

      return res.status(400).json({
        ok: false,
        error: "A Meta recusou a consulta. Verifique os logs da Vercel."
      });
    }

    return res.status(200).json({
      ok: true,
      valid: true,
      username: data.username || null,
      instagram_user_id: data.id || null
    });

  } catch (error) {
    console.error("Instagram verify:", error.message);

    return res.status(500).json({
      ok: false,
      error: "Falha ao verificar a conta."
    });
  }
};
