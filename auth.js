const crypto = require("crypto");

function creds() {
  return {
    appId: process.env.META_APP_ID,
    appSecret: process.env.META_APP_SECRET,
    redirectUri: process.env.META_REDIRECT_URI,
    supabaseUrl: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    configId:
      process.env.META_INSTAGRAM_CONFIG_ID ||
      process.env.META_CONFIG_ID,
    siteUrl:
      process.env.SITE_URL || process.env.APP_URL,
  };
}

// Gera assinatura HMAC para proteger o state do OAuth.
function sign(payload, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
}

// Compara valores sem comparação simples de strings.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }

  const valueA = Buffer.from(a);
  const valueB = Buffer.from(b);

  if (valueA.length !== valueB.length) {
    return false;
  }

  return crypto.timingSafeEqual(valueA, valueB);
}

// Lê um cookie da requisição.
function readCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");

    if (separator === -1) continue;

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === name) {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }

  return null;
}

// Criptografa um token com AES-256-GCM.
function encryptToken(token, secret) {
  const key = crypto
    .createHash("sha256")
    .update(secret)
    .digest();

  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}

// Descriptografa um token salvo.
function decryptToken(value, secret) {
  if (!value || typeof value !== "string") {
    throw new Error("Token criptografado inválido.");
  }

  const parts = value.split(":");

  if (parts.length !== 3) {
    throw new Error("Formato do token criptografado inválido.");
  }

  const [ivHex, tagHex, encryptedHex] = parts;

  const key = crypto
    .createHash("sha256")
    .update(secret)
    .digest();

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex")
  );

  decipher.setAuthTag(Buffer.from(tagHex, "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

// Valida a sessão do usuário no Supabase.
async function getUser(accessToken) {
  const { supabaseUrl, anonKey } = creds();

  if (!supabaseUrl || !anonKey || !accessToken) {
    return null;
  }

  const response = await fetch(
    `${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`,
    {
      method: "GET",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    return null;
  }

  return response.json();
}

// Faz chamadas REST ao Supabase usando a service role.
async function db(path, options = {}) {
  const { supabaseUrl, serviceRoleKey } = creds();

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Configuração Supabase incompleta.");
  }

  const url =
    `${supabaseUrl.replace(/\/$/, "")}/rest/v1/` +
    path.replace(/^\/+/, "");

  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const responseText = await response.text();

  if (!response.ok) {
    console.error("Erro Supabase:", response.status, responseText);

    throw new Error(
      `Supabase ${response.status}: ${responseText}`
    );
  }

  if (!responseText) {
    return null;
  }

  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
}

module.exports = {
  creds,
  sign,
  safeEqual,
  readCookie,
  encryptToken,
  decryptToken,
  getUser,
  db,
};
