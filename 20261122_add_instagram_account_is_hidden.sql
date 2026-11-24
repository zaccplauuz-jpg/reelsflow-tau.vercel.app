const { getUser, db } = require("../helpers");

const API_VERSION = process.env.IG_API_VERSION || "v27.0";

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

async function checkMetaAccount(account) {
  if (!account.instagram_user_id || !account.access_token) {
    return { id: account.id, status: "disconnected", reason: "missing_token" };
  }

  try {
    const url = new URL(
      `https://graph.facebook.com/${API_VERSION}/${encodeURIComponent(String(account.instagram_user_id))}`
    );
    url.searchParams.set("fields", "id,username");
    url.searchParams.set("access_token", account.access_token);

    const response = await fetch(url.toString());
    const data = await response.json().catch(() => ({}));

    if (response.ok && !data.error && data.id) {
      return { id: account.id, status: "active" };
    }

    const code = Number(data.error?.code);
    // Só erros explícitos de token/sessão inválidos desativam a conta.
    // Erros de permissão, limite, rede ou indisponibilidade ficam como inconclusivos.
    if (code === 190 || code === 102) {
      return { id: account.id, status: "disconnected", reason: "invalid_token" };
    }

    return { id: account.id, status: "unknown", reason: "meta_unavailable" };
  } catch (error) {
    console.error("Verificação de conexão Instagram:", error.message);
    return { id: account.id, status: "unknown", reason: "request_failed" };
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendError(res, 405, "Método não permitido.");
  }

  try {
    const authorization = req.headers.authorization || "";
    if (!authorization.startsWith("Bearer ")) {
      return sendError(res, 401, "Entre novamente no Reels Manager.");
    }

    const user = await getUser(authorization.slice(7));
    if (!user?.id) {
      return sendError(res, 401, "Sessão inválida ou expirada. Entre novamente.");
    }

    const rows = await db(
      "instagram_accounts?select=id,username,instagram_user_id,access_token,connection_status" +
      "&owner_id=eq." + encodeURIComponent(user.id),
      { method: "GET" }
    );

    const accounts = Array.isArray(rows) ? rows : [];
    const results = accounts.map(account => ({
      id: account.id,
      status: account.connection_status === "connected" ? "checking" : "disconnected"
    }));

    const connected = accounts.filter(account => account.connection_status === "connected");
    let nextIndex = 0;

    const workers = Array.from(
      { length: Math.min(3, connected.length) },
      async () => {
        while (nextIndex < connected.length) {
          const account = connected[nextIndex++];
          const result = await checkMetaAccount(account);
          const position = results.findIndex(item => String(item.id) === String(account.id));

          if (position >= 0) results[position] = result;

          if (result.status === "disconnected") {
            await db(
              "instagram_accounts?id=eq." + encodeURIComponent(account.id) +
              "&owner_id=eq." + encodeURIComponent(user.id),
              {
                method: "PATCH",
                headers: { Prefer: "return=minimal" },
                body: JSON.stringify({
                  connection_status: "disconnected",
                  updated_at: new Date().toISOString()
                })
              }
            );
          }
        }
      }
    );

    await Promise.all(workers);

    return res.status(200).json({
      checkedAt: new Date().toISOString(),
      results
    });
  } catch (error) {
    console.error("Instagram connection check:", error.message);
    return sendError(
      res,
      500,
      "Não foi possível verificar as conexões do Instagram agora."
    );
  }
};
