
const {
  creds,
  db,
  decryptToken,
} = require("../helpers");

const API_VERSION = process.env.IG_API_VERSION || "v27.0";
const GRAPH_URL = `https://graph.facebook.com/${API_VERSION}`;
const BUCKET = "reels-videos";
const LIMIT = 3;

function json(res, status, data) {
  return res.status(status).json(data);
}

function getToken(value, appSecret) {
  if (!value) return "";

  const parts = String(value).split(":");

  if (parts.length === 3) {
    return decryptToken(value, appSecret);
  }

  return value;
}

async function storageSignedUrl(path, config) {
  const encodedPath = path
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  const response = await fetch(
    `${config.supabaseUrl}/storage/v1/object/sign/${BUCKET}/${encodedPath}`,
    {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: 21600 }),
    }
  );

  const data = await response.json();

  if (!response.ok || !data.signedURL) {
    throw new Error(
      "Não foi possível gerar o link temporário do vídeo."
    );
  }

  return `${config.supabaseUrl}/storage/v1${data.signedURL}`;
}

async function graphRequest(method, endpoint, params, token) {
  const query = new URLSearchParams({
    ...params,
    access_token: token,
  });

  const response = await fetch(
    `${GRAPH_URL}/${endpoint}?${query.toString()}`,
    { method }
  );

  const data = await response.json();

  if (!response.ok || data.error) {
    throw new Error(
      data.error?.message ||
      "Erro na comunicação com o Instagram."
    );
  }

  return data;
}

async function getAccount(accountId, ownerId) {
  const rows = await db(
    `instagram_accounts?select=id,owner_id,instagram_user_id,access_token,connection_status&id=eq.${encodeURIComponent(accountId)}`
  );

  const account = Array.isArray(rows) ? rows[0] : null;

  if (
    !account ||
    account.owner_id !== ownerId ||
    account.connection_status !== "connected" ||
    !account.instagram_user_id ||
    !account.access_token
  ) {
    throw new Error(
      "Conta do Instagram não está conectada corretamente."
    );
  }

  return account;
}

async function getVideoPath(ownerId, videoId) {
  const rows = await db(
    `videos?select=id,owner_id,storage_path&id=eq.${encodeURIComponent(videoId)}&owner_id=eq.${encodeURIComponent(ownerId)}`
  );

  const video = Array.isArray(rows) ? rows[0] : null;

  if (!video || !video.storage_path) {
    throw new Error(
      "Vídeo não encontrado ou sem caminho no Storage."
    );
  }

  return video.storage_path;
}

async function markFailed(id, message) {
  await db(
    `scheduled_posts?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        status: "failed",
        error_message: String(message).slice(0, 1000),
      }),
    }
  );
}

async function publishContainer(post, account, config) {
  const token = getToken(
    account.access_token,
    config.appSecret
  );

  const status = await graphRequest(
    "GET",
    post.platform_media_id,
    { fields: "status_code,status" },
    token
  );

  if (
    status.status_code === "ERROR" ||
    status.status_code === "EXPIRED"
  ) {
    throw new Error(
      status.status ||
      "O Instagram não conseguiu processar o vídeo."
    );
  }

  if (status.status_code !== "FINISHED") {
    return "processing";
  }

  const published = await graphRequest(
    "POST",
    `${account.instagram_user_id}/media_publish`,
    { creation_id: post.platform_media_id },
    token
  );

  if (!published.id) {
    throw new Error(
      "O Instagram não retornou o ID da publicação."
    );
  }

  await db(
    `scheduled_posts?id=eq.${encodeURIComponent(post.id)}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        status: "published",
        published_at: new Date().toISOString(),
        platform_media_id: published.id,
        error_message: null,
      }),
    }
  );

  return "published";
}

async function startContainer(post, config) {
  const account = await getAccount(
    post.instagram_account_id,
    post.owner_id
  );

  const path = await getVideoPath(
    post.owner_id,
    post.video_id
  );

  const videoUrl = await storageSignedUrl(path, config);

  const token = getToken(
    account.access_token,
    config.appSecret
  );

  const container = await graphRequest(
    "POST",
    `${account.instagram_user_id}/media`,
    {
      media_type: "REELS",
      video_url: videoUrl,
      caption: post.caption || "",
      share_to_feed: "true",
    },
    token
  );

  if (!container.id) {
    throw new Error(
      "O Instagram não retornou o ID do vídeo."
    );
  }

  await db(
    `scheduled_posts?id=eq.${encodeURIComponent(post.id)}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        platform_media_id: container.id,
        error_message: null,
      }),
    }
  );

  return container.id;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return json(res, 405, {
      error: "Método não permitido.",
    });
  }

  const secret = process.env.CRON_SECRET;
  const supplied = req.headers.authorization || "";

  if (!secret || supplied !== `Bearer ${secret}`) {
    return json(res, 401, {
      error: "Não autorizado.",
    });
  }

  try {
    const config = creds();

    if (
      !config.supabaseUrl ||
      !config.serviceRoleKey ||
      !config.appSecret
    ) {
      throw new Error(
        "Configuração do Supabase ou da Meta incompleta."
      );
    }

    // Verifica os vídeos já enviados ao Instagram.
    const processing = await db(
      `scheduled_posts?select=id,owner_id,instagram_account_id,platform_media_id,status&status=eq.processing&platform_media_id=not.is.null&limit=${LIMIT}`
    );

    let checked = 0;
    let published = 0;

    for (const post of processing || []) {
      try {
        const account = await getAccount(
          post.instagram_account_id,
          post.owner_id
        );

        const result = await publishContainer(
          post,
          account,
          config
        );

        if (result === "published") {
          published++;
        }
      } catch (error) {
        await markFailed(post.id, error.message);
      }

      checked++;
    }

    // Reserva novos agendamentos vencidos.
    const due = await db(
      "rpc/claim_due_scheduled_posts",
      {
        method: "POST",
        body: JSON.stringify({
          p_limit: LIMIT,
        }),
      }
    );

    let started = 0;

    for (const post of due || []) {
      try {
        await startContainer(post, config);
        started++;
      } catch (error) {
        await markFailed(post.id, error.message);
      }
    }

    return json(res, 200, {
      ok: true,
      checked,
      published,
      started,
    });
  } catch (error) {
    console.error(
      "Erro no publicador:",
      error.message
    );

    return json(res, 500, {
      error: "Erro ao executar o publicador.",
    });
  }
};
