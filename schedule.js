
const { getUser, db } = require("../helpers");

const API_VERSION = process.env.IG_API_VERSION || "v27.0";

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

async function graphGet(path, token, params = {}) {
  const url = new URL(`https://graph.facebook.com/${API_VERSION}/${path}`);
  url.searchParams.set("access_token", token);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString());
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    const error = new Error(
      data.error?.error_user_msg ||
      data.error?.message ||
      `A Meta retornou erro HTTP ${response.status}.`
    );
    error.code = data.error?.code;
    throw error;
  }

  return data;
}

function metricValues(data) {
  const result = {};
  for (const metric of Array.isArray(data) ? data : []) {
    const values = Array.isArray(metric.values) ? metric.values : [];
    const numbers = values
      .map(item => Number(item.value))
      .filter(Number.isFinite);

    if (!numbers.length) continue;

    // Alcance e contas engajadas são apresentados como o valor mais recente.
    // Visualizações e interações são somadas no período consultado.
    result[metric.name] =
      metric.name === "reach" || metric.name === "accounts_engaged"
        ? numbers[numbers.length - 1]
        : numbers.reduce((sum, value) => sum + value, 0);
  }
  return result;
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
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

    const accountId = String(req.query?.accountId || "").trim();
    if (!accountId) {
      return sendError(res, 400, "Informe a conta do Instagram.");
    }

    const rows = await db(
      "instagram_accounts?select=id,username,instagram_user_id,access_token,connection_status" +
      "&owner_id=eq." + encodeURIComponent(user.id) +
      "&id=eq." + encodeURIComponent(accountId),
      { method: "GET" }
    );

    const account = Array.isArray(rows) ? rows[0] : null;
    if (!account) {
      return sendError(res, 404, "Conta do Instagram não encontrada.");
    }

    if (account.connection_status !== "connected" ||
        !account.instagram_user_id || !account.access_token) {
      return sendError(res, 409, "Reconecte esta conta do Instagram para consultar os insights.");
    }

    const profile = await graphGet(
      String(account.instagram_user_id),
      account.access_token,
      { fields: "username,followers_count,media_count" }
    );

    const now = Math.floor(Date.now() / 1000);
    const since = now - 7 * 24 * 60 * 60;
    let insights = {};
    let insightsError = null;

    try {
      const data = await graphGet(
        String(account.instagram_user_id) + "/insights",
        account.access_token,
        {
          metric: "reach,accounts_engaged,total_interactions,views",
          period: "day",
          since,
          until: now
        }
      );
      insights = metricValues(data.data);
      const returnedMetrics = new Set(
        (Array.isArray(data.data) ? data.data : []).map(metric => metric.name)
      );
      const missingMetrics = ["reach", "accounts_engaged", "total_interactions", "views"]
        .filter(name => !returnedMetrics.has(name));
      if (missingMetrics.length === 4) {
        insightsError = "A Meta não retornou métricas para este perfil no período consultado. Verifique instagram_manage_insights e o acesso da conta.";
      }
    } catch (error) {
      insightsError = error.message;
    }

    const followers = profile.followers_count == null
      ? null
      : Number(profile.followers_count);
    const interactions = Number(insights.total_interactions) || 0;

    return res.status(200).json({
      accountId: account.id,
      username: profile.username || account.username,
      followers,
      mediaCount: Number(profile.media_count) || 0,
      reach: Number(insights.reach) || 0,
      views: Number(insights.views) || 0,
      engagedAccounts: Number(insights.accounts_engaged) || 0,
      interactions,
      engagementRate: followers > 0
        ? Number((interactions / followers * 100).toFixed(2))
        : 0,
      periodDays: 7,
      updatedAt: new Date().toISOString(),
      insightsError
    });
  } catch (error) {
    console.error("Instagram insights API:", error.message);
    return sendError(
      res,
      500,
      error.message || "Não foi possível consultar os insights do Instagram."
    );
  }
};
