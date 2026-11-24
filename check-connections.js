
const crypto = require("crypto");
const { creds, sign, db } = require("../helpers");

const COOKIE_NAME = "ig_oauth_state";
const COOKIE_PATH = "/api/instagram";
const API_VERSION = process.env.IG_API_VERSION || "v27.0";
const STATE_TTL = 10 * 60 * 1000;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }

  const first = Buffer.from(a);
  const second = Buffer.from(b);

  if (first.length !== second.length) {
    return false;
  }

  return crypto.timingSafeEqual(first, second);
}

function readCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";

  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");

    if (separator === -1) continue;

    const key = cookie.slice(0, separator).trim();
    const value = cookie.slice(separator + 1).trim();

    if (key === name) {
      try {
        return decodeURIComponent(value);
      } catch {
        return "";
      }
    }
  }

  return "";
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).send("Método não permitido.");
  }

  const config = creds();

  const appId = config.appId;
  const appSecret = config.appSecret;
  const redirectUri = config.redirectUri;

  const siteUrl = config.siteUrl || (redirectUri ? new URL(redirectUri).origin : "");

  function finish(status, detail) {
    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=0`
    );

    const params = new URLSearchParams({
      instagram: status
    });

    if (detail) {
      params.set("detail", String(detail).slice(0, 180));
    }

    return res.redirect(`${siteUrl.replace(/\/+$/, "")}/?${params.toString()}`);
  }

  async function graphGet(path, token, fields) {
    const url = new URL(
      `https://graph.facebook.com/${API_VERSION}/${path}`
    );

    url.searchParams.set("access_token", token);

    if (fields) {
      url.searchParams.set("fields", fields);
    }

    const response = await fetch(url.toString());
    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.error) {
      const message =
        data.error?.message ||
        `Erro Graph API: ${response.status}`;

      console.error("Meta Graph API:", message);
      throw new Error(message);
    }

    return data;
  }

  try {
    const query = req.query || {};

    const code = query.code;
    const state = query.state;
    const oauthError = query.error;

    if (oauthError) {
      return finish("cancelled", "Autorização cancelada na Meta.");
    }

    if (
      !code ||
      !state ||
      typeof code !== "string" ||
      typeof state !== "string"
    ) {
      return finish(
        "error",
        "Código ou estado de autorização ausente."
      );
    }

    if (!appId || !appSecret || !redirectUri) {
      return finish(
        "error",
        "Configuração da Meta incompleta no servidor."
      );
    }

    // Valida a assinatura do state.
    const parts = state.split(".");
    const payload = parts[0];
    const signature = parts[1];

    if (
      !payload ||
      !signature ||
      !safeEqual(signature, sign(payload, appSecret))
    ) {
      return finish("error", "Validação de segurança inválida.");
    }

    // Confere o cookie de segurança.
    const cookieState = readCookie(req, COOKIE_NAME);

    if (!cookieState || !safeEqual(cookieState, state)) {
      return finish(
        "error",
        "Sessão expirada. Conecte novamente."
      );
    }

    // Recupera os dados do state.
    let stateData;

    try {
      stateData = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8")
      );
    } catch {
      return finish("error", "Estado de autorização inválido.");
    }

    const age = Date.now() - Number(stateData.iat);

    if (
      !stateData.userId ||
      !stateData.nonce ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > STATE_TTL
    ) {
      return finish(
        "error",
        "Autorização expirada. Tente novamente."
      );
    }

    // Confere a conta escolhida.
    const requestedUsername = String(
      stateData.instagramUsername || ""
    )
      .trim()
      .replace(/^@/, "")
      .toLowerCase();

    if (!/^[a-z0-9._]{1,30}$/.test(requestedUsername)) {
      return finish(
        "error",
        "Conta Instagram selecionada inválida."
      );
    }

    // Troca o código pelo token de acesso.
    const tokenUrl = new URL(
      `https://graph.facebook.com/${API_VERSION}/oauth/access_token`
    );

    tokenUrl.searchParams.set("client_id", appId);
    tokenUrl.searchParams.set("client_secret", appSecret);
    tokenUrl.searchParams.set("redirect_uri", redirectUri);
    tokenUrl.searchParams.set("code", code);

    const tokenResponse = await fetch(tokenUrl.toString());
    const tokenData = await tokenResponse.json().catch(() => ({}));

    if (
      !tokenResponse.ok ||
      typeof tokenData.access_token !== "string" ||
      !tokenData.access_token.trim()
    ) {
      console.error(
        "Meta token exchange:",
        tokenData.error?.message || "Token não recebido."
      );

      return finish(
        "error",
        tokenData.error?.message ||
          "A Meta não forneceu o token de acesso."
      );
    }

    const accessToken = tokenData.access_token;
    const expiresIn = Number(tokenData.expires_in);

    const expiresAt =
      Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : null;

    // Busca as contas disponíveis na Meta.
    const accountsData = await graphGet(
      "me/assigned_instagram_accounts",
      accessToken,
      "id,username"
    );

    const accounts = Array.isArray(accountsData.data)
      ? accountsData.data
      : [];

    if (accounts.length === 0) {
      return finish(
        "error",
        "A Meta não retornou contas Instagram. Verifique os ativos compartilhados e a permissão instagram_basic."
      );
    }

    // Seleciona somente a conta solicitada.
    const selectedAccount = accounts.find(
      account =>
        String(account.username || "")
          .trim()
          .replace(/^@/, "")
          .toLowerCase() === requestedUsername
    );

    if (!selectedAccount || !selectedAccount.id) {
      return finish(
        "error",
        "A conta Instagram selecionada não foi encontrada entre as contas disponíveis na Meta."
      );
    }

    // Salva ou atualiza somente a conta selecionada.
    const instagramId = String(selectedAccount.id);
    const username = selectedAccount.username || instagramId;
    const now = new Date().toISOString();

    const filter =
      "instagram_accounts?" +
      `owner_id=eq.${encodeURIComponent(stateData.userId)}` +
      `&instagram_user_id=eq.${encodeURIComponent(instagramId)}` +
      "&select=id";

    const existing = await db(filter, {
      method: "GET"
    });

    const row = {
      owner_id: stateData.userId,
      instagram_user_id: instagramId,
      username,
      account_type: "creator",
      access_token: accessToken,
      token_expires_at: expiresAt,
      connection_status: "connected",
      updated_at: now
    };

    if (Array.isArray(existing) && existing.length > 0) {
      const updateFilter =
        "instagram_accounts?" +
        `owner_id=eq.${encodeURIComponent(stateData.userId)}` +
        `&instagram_user_id=eq.${encodeURIComponent(instagramId)}`;

      await db(updateFilter, {
        method: "PATCH",
        headers: {
          Prefer: "return=minimal"
        },
        body: JSON.stringify(row)
      });
    } else {
      await db("instagram_accounts", {
        method: "POST",
        headers: {
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          ...row,
          created_at: now
        })
      });
    }

    console.log(
      `Instagram: conta @${username} conectada.`
    );

    return finish("connected");

  } catch (error) {
    console.error("Instagram callback:", error.message);

    return finish(
      "error",
      error.message || "Erro ao concluir a conexão com o Instagram."
    );
  }
};
