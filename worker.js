const WEBHOOK_PATH = "/endpoint";
const MAP_TTL_SECONDS = 30 * 24 * 60 * 60;
const RATE_LIMIT_MS = 3 * 1000;
const RATE_TTL_SECONDS = 120; // Cloudflare KV requires >= 60.
const UNBLOCK_ALL_CONFIRM_KEY = "admin:confirm:unblockall";
const UNBLOCK_ALL_CONFIRM_TTL_SECONDS = 60;
const TELEGRAM_MAX_ATTEMPTS = 4; // first attempt + 3 retries

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === WEBHOOK_PATH) {
      return handleWebhook(request, env, ctx);
    }
    if (url.pathname === "/registerWebhook") {
      return registerWebhook(url, env);
    }
    if (url.pathname === "/unregisterWebhook") {
      return unregisterWebhook(env);
    }
    if (url.pathname === "/health") {
      return new Response("ok");
    }
    return new Response("Not Found", { status: 404 });
  },
};

async function handleWebhook(request, env, ctx) {
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.ENV_BOT_SECRET) {
    return new Response("Unauthorized", { status: 403 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  ctx.waitUntil(onUpdate(update, env));
  return new Response("OK");
}

async function onUpdate(update, env) {
  const message = update?.message;
  if (!message?.chat || message.chat.type !== "private") {
    return;
  }
  const isAdmin = String(message.chat.id) === String(env.ENV_ADMIN_UID);
  return isAdmin ? onAdminMessage(message, env) : onGuestMessage(message, env);
}

async function onGuestMessage(message, env) {
  const guestId = String(message.chat.id);

  if ((await env.nfd.get(`block:${guestId}`)) === "1") {
    return sendText(guestId, "你已被禁止联系该机器人。", env);
  }

  if ((await env.nfd.get(`allow:${guestId}`)) !== "1") {
    return handleFirstContactGate(message, env);
  }

  let rateLimited = false;
  try {
    rateLimited = await isGuestRateLimited(guestId, env);
  } catch (error) {
    await notifyAdminDebug(env, `限频检查异常，已放行。uid=${guestId} error=${error?.message || "unknown"}`);
  }
  if (rateLimited) {
    return sendText(guestId, "发送过快，请稍后再试。", env);
  }

  const result = await telegramApi(
    "forwardMessage",
    {
      chat_id: env.ENV_ADMIN_UID,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
    },
    env
  );

  if (!result.ok || !result.result?.message_id) {
    await sendText(guestId, "消息发送失败，请稍后再试。", env);
    await notifyAdminDebug(env, `消息转发失败。uid=${guestId} reason=${result.description || "unknown"}`);
    return;
  }

  await env.nfd.put(`map:${result.result.message_id}`, guestId, {
    expirationTtl: MAP_TTL_SECONDS,
  });
}

async function handleFirstContactGate(message, env) {
  const guestId = String(message.chat.id);
  const joinCode = String(env.ENV_JOIN_CODE || "").trim();
  const text = String(message.text || "").trim();
  const verifyCommand = `/verify ${joinCode}`.trim();

  if (!joinCode) {
    return sendText(guestId, "机器人尚未完成配置，请稍后再试。", env);
  }

  if (text === verifyCommand) {
    await env.nfd.put(`allow:${guestId}`, "1");
    return sendText(guestId, "验证成功，现在可以开始私聊。", env);
  }

  return sendText(guestId, `请先发送验证命令：${verifyCommand}\n通过验证后才能开始私聊。`, env);
}

async function onAdminMessage(message, env) {
  const text = String(message.text || "").trim();
  const command = parseCommand(text);

  if (!command) {
    return replyToGuest(message, env);
  }

  const { name, arg } = command;
  if (name === "start" || name === "help") {
    return sendText(env.ENV_ADMIN_UID, helpText(), env);
  }
  if (name === "blocklist") {
    return sendBlockList(env);
  }
  if (name === "unblockall") {
    return requestUnblockAllConfirm(env);
  }
  if (name === "confirm_unblockall") {
    return confirmAndHandleUnblockAll(env);
  }
  if (name === "block" || name === "unblock") {
    return handleBlockCommand(message, name, arg, env);
  }

  return replyToGuest(message, env);
}

function parseCommand(text) {
  const match = text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+(.+))?$/i);
  if (!match) {
    return null;
  }
  return { name: match[1].toLowerCase(), arg: (match[2] || "").trim() };
}

function helpText() {
  return [
    "用法：回复一条转发消息后可执行以下命令",
    "/block - 屏蔽该用户",
    "/block <uid> - 按 UID 屏蔽",
    "/unblock - 解除屏蔽",
    "/unblock <uid> - 按 UID 解除屏蔽",
    "/unblockall - 发起解除所有屏蔽确认",
    "/confirm_unblockall - 确认执行解除所有屏蔽",
    "/blocklist - 查看屏蔽列表",
    "直接回复普通消息可回传给用户",
  ].join("\n");
}

async function replyToGuest(message, env) {
  if (!message.reply_to_message) {
    return;
  }
  const guestId = await getGuestIdFromReply(message.reply_to_message, env);
  if (!guestId) {
    return sendText(env.ENV_ADMIN_UID, "未找到目标用户，请回复一条转发消息。", env);
  }
  const result = await telegramApi(
    "copyMessage",
    {
      chat_id: guestId,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
    },
    env
  );
  if (!result.ok) {
    await sendText(env.ENV_ADMIN_UID, `回传失败：${result.description || "unknown"}`, env);
  }
}

async function handleBlockCommand(message, action, arg, env) {
  const guestId = await resolveTargetUid(message, arg, env);
  if (!guestId) {
    return sendText(
      env.ENV_ADMIN_UID,
      "未找到目标用户。请回复转发消息，或使用命令 /block <uid>、/unblock <uid>。",
      env
    );
  }
  if (guestId === String(env.ENV_ADMIN_UID)) {
    return sendText(env.ENV_ADMIN_UID, "不能操作管理员账号。", env);
  }

  if (action === "block") {
    await env.nfd.put(`block:${guestId}`, "1");
    return sendText(env.ENV_ADMIN_UID, `已屏蔽用户 ${guestId}`, env);
  }

  await env.nfd.delete(`block:${guestId}`);
  return sendText(env.ENV_ADMIN_UID, `已解除屏蔽 ${guestId}`, env);
}

async function resolveTargetUid(message, arg, env) {
  if (arg) {
    return /^-?\d+$/.test(arg) ? arg : null;
  }
  if (!message.reply_to_message) {
    return null;
  }
  return getGuestIdFromReply(message.reply_to_message, env);
}

async function requestUnblockAllConfirm(env) {
  await env.nfd.put(UNBLOCK_ALL_CONFIRM_KEY, "1", {
    expirationTtl: UNBLOCK_ALL_CONFIRM_TTL_SECONDS,
  });
  return sendText(env.ENV_ADMIN_UID, "确认执行请在 60 秒内发送 /confirm_unblockall 。", env);
}

async function confirmAndHandleUnblockAll(env) {
  if ((await env.nfd.get(UNBLOCK_ALL_CONFIRM_KEY)) !== "1") {
    return sendText(
      env.ENV_ADMIN_UID,
      "请先发送 /unblockall 发起确认，再在 60 秒内发送 /confirm_unblockall。",
      env
    );
  }
  await env.nfd.delete(UNBLOCK_ALL_CONFIRM_KEY);

  let cursor;
  let deleted = 0;
  do {
    const page = await env.nfd.list({ prefix: "block:", cursor });
    for (const key of page.keys) {
      await env.nfd.delete(key.name);
      deleted += 1;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const text = deleted === 0 ? "当前没有屏蔽用户。" : `已解除所有屏蔽，共 ${deleted} 个用户。`;
  return sendText(env.ENV_ADMIN_UID, text, env);
}

async function sendBlockList(env) {
  let cursor;
  let count = 0;
  const ids = [];

  do {
    const page = await env.nfd.list({ prefix: "block:", cursor });
    for (const key of page.keys) {
      ids.push(key.name.slice("block:".length));
      count += 1;
      if (count >= 200) {
        break;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && count < 200);

  if (ids.length === 0) {
    return sendText(env.ENV_ADMIN_UID, "当前没有屏蔽用户。", env);
  }
  const body = ids.map((id, i) => `${i + 1}. ${id}`).join("\n");
  const suffix = count >= 200 ? "\n(仅显示前 200 条)" : "";
  return sendText(env.ENV_ADMIN_UID, `屏蔽列表：\n${body}${suffix}`, env);
}

async function getGuestIdFromReply(replyMessage, env) {
  if (typeof replyMessage?.message_id === "undefined") {
    return null;
  }
  return env.nfd.get(`map:${replyMessage.message_id}`);
}

async function isGuestRateLimited(guestId, env) {
  const key = `rate:${guestId}`;
  const now = Date.now();
  const last = Number(await env.nfd.get(key));
  const limited = Number.isFinite(last) && now >= last && now - last < RATE_LIMIT_MS;
  await env.nfd.put(key, String(now), { expirationTtl: RATE_TTL_SECONDS });
  return limited;
}

async function notifyAdminDebug(env, text) {
  await sendText(env.ENV_ADMIN_UID, `[debug] ${text}`, env);
}

async function telegramApi(methodName, payload, env) {
  let lastDescription = "Telegram API request failed";

  for (let attempt = 1; attempt <= TELEGRAM_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${env.ENV_BOT_TOKEN}/${methodName}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (response.ok && result?.ok) {
        return result;
      }
      lastDescription = result?.description || `HTTP ${response.status}`;
    } catch (error) {
      lastDescription = error?.message || "Network error";
    }

    if (attempt < TELEGRAM_MAX_ATTEMPTS) {
      await sleep(200 * 2 ** (attempt - 1));
    }
  }

  return { ok: false, description: lastDescription };
}

async function sendText(chatId, text, env) {
  await telegramApi("sendMessage", { chat_id: chatId, text }, env);
}

async function registerWebhook(url, env) {
  const result = await telegramApi(
    "setWebhook",
    { url: `${url.origin}${WEBHOOK_PATH}`, secret_token: env.ENV_BOT_SECRET },
    env
  );
  return new Response(result.ok ? "OK" : JSON.stringify(result, null, 2), {
    status: result.ok ? 200 : 500,
  });
}

async function unregisterWebhook(env) {
  const result = await telegramApi("setWebhook", { url: "" }, env);
  return new Response(result.ok ? "OK" : JSON.stringify(result, null, 2), {
    status: result.ok ? 200 : 500,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
