const WEBHOOK_PATH = "/endpoint";
const MAP_TTL_SECONDS = 60 * 60 * 24 * 30;

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
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== env.ENV_BOT_SECRET) {
    return new Response("Unauthorized", { status: 403 });
  }

  let update;
  try {
    update = await request.json();
  } catch (_error) {
    return new Response("Bad Request", { status: 400 });
  }

  ctx.waitUntil(onUpdate(update, env));
  return new Response("OK");
}

async function onUpdate(update, env) {
  if (!update || !update.message) {
    return;
  }
  await onMessage(update.message, env);
}

async function onMessage(message, env) {
  if (!message.chat || message.chat.type !== "private") {
    return;
  }

  const adminId = String(env.ENV_ADMIN_UID);
  const chatId = String(message.chat.id);

  if (chatId === adminId) {
    await onAdminMessage(message, env);
    return;
  }

  await onGuestMessage(message, env);
}

async function onGuestMessage(message, env) {
  const guestId = String(message.chat.id);
  const isBlocked = await env.nfd.get(`block:${guestId}`);

  if (isBlocked === "1") {
    await sendText(guestId, "你已被禁止联系该机器人。", env);
    return;
  }

  const isAllowed = await env.nfd.get(`allow:${guestId}`);
  if (isAllowed !== "1") {
    await handleFirstContactGate(message, env);
    return;
  }

  const forwardResult = await telegramApi(
    "forwardMessage",
    {
      chat_id: env.ENV_ADMIN_UID,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
    },
    env
  );

  if (!forwardResult.ok || !forwardResult.result) {
    await sendText(guestId, "消息发送失败，请稍后再试。", env);
    return;
  }

  const adminForwardMessageId = String(forwardResult.result.message_id);
  await env.nfd.put(`map:${adminForwardMessageId}`, guestId, {
    expirationTtl: MAP_TTL_SECONDS,
  });
}

async function handleFirstContactGate(message, env) {
  const guestId = String(message.chat.id);
  const joinCode = String(env.ENV_JOIN_CODE || "").trim();
  const verifyCommand = `/verify ${joinCode}`.trim();
  const text = (message.text || "").trim();

  if (!joinCode) {
    await sendText(guestId, "机器人尚未完成配置，请稍后再试。", env);
    return;
  }

  if (text === verifyCommand) {
    await env.nfd.put(`allow:${guestId}`, "1");
    await sendText(guestId, "验证成功，现在可以开始私聊。", env);
    return;
  }

  await sendText(
    guestId,
    `请先发送验证命令：${verifyCommand}\n通过验证后才能开始私聊。`,
    env
  );
}

async function onAdminMessage(message, env) {
  const text = (message.text || "").trim();
  const blockMatch = text.match(/^\/block(?:@\w+)?(?:\s+(-?\d+))?$/);
  const unblockMatch = text.match(/^\/unblock(?:@\w+)?(?:\s+(-?\d+))?$/);

  if (text === "/start" || text === "/help") {
    await sendText(
      env.ENV_ADMIN_UID,
      [
        "用法：回复一条转发消息后可执行以下命令",
        "/block - 屏蔽该用户",
        "/block <uid> - 按 UID 屏蔽",
        "/unblock - 解除屏蔽",
        "/unblock <uid> - 按 UID 解除屏蔽",
        "/unblockall - 解除所有屏蔽",
        "/blocklist - 查看屏蔽列表",
        "直接回复普通消息可回传给用户",
      ].join("\n"),
      env
    );
    return;
  }

  if (text === "/blocklist") {
    await sendBlockList(env);
    return;
  }

  if (text === "/unblockall") {
    await handleUnblockAll(env);
    return;
  }

  if (blockMatch) {
    await handleBlockCommand(message, "/block", blockMatch[1], env);
    return;
  }

  if (unblockMatch) {
    await handleBlockCommand(message, "/unblock", unblockMatch[1], env);
    return;
  }

  if (!message.reply_to_message) {
    return;
  }

  const guestId = await getGuestIdFromReply(message.reply_to_message, env);
  if (!guestId) {
    await sendText(env.ENV_ADMIN_UID, "未找到目标用户，请回复一条转发消息。", env);
    return;
  }

  await telegramApi(
    "copyMessage",
    {
      chat_id: guestId,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
    },
    env
  );
}

async function handleBlockCommand(message, cmd, commandUid, env) {
  let guestId = commandUid;

  if (!guestId && message.reply_to_message) {
    guestId = await getGuestIdFromReply(message.reply_to_message, env);
  }

  if (!guestId) {
    await sendText(
      env.ENV_ADMIN_UID,
      "未找到目标用户。请回复转发消息，或使用命令 /block <uid>、/unblock <uid>。",
      env
    );
    return;
  }

  if (String(guestId) === String(env.ENV_ADMIN_UID)) {
    await sendText(env.ENV_ADMIN_UID, "不能操作管理员账号。", env);
    return;
  }

  if (cmd === "/block") {
    await env.nfd.put(`block:${guestId}`, "1");
    await sendText(env.ENV_ADMIN_UID, `已屏蔽用户 ${guestId}`, env);
    return;
  }

  await env.nfd.delete(`block:${guestId}`);
  await sendText(env.ENV_ADMIN_UID, `已解除屏蔽 ${guestId}`, env);
}

async function handleUnblockAll(env) {
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

  if (deleted === 0) {
    await sendText(env.ENV_ADMIN_UID, "当前没有屏蔽用户。", env);
    return;
  }

  await sendText(env.ENV_ADMIN_UID, `已解除所有屏蔽，共 ${deleted} 个用户。`, env);
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
    await sendText(env.ENV_ADMIN_UID, "当前没有屏蔽用户。", env);
    return;
  }

  const body = ids.map((id, index) => `${index + 1}. ${id}`).join("\n");
  const suffix = count >= 200 ? "\n(仅显示前 200 条)" : "";
  await sendText(env.ENV_ADMIN_UID, `屏蔽列表：\n${body}${suffix}`, env);
}

async function getGuestIdFromReply(replyMessage, env) {
  if (!replyMessage || typeof replyMessage.message_id === "undefined") {
    return null;
  }
  const key = `map:${replyMessage.message_id}`;
  return env.nfd.get(key);
}

function telegramApiUrl(methodName, env) {
  return `https://api.telegram.org/bot${env.ENV_BOT_TOKEN}/${methodName}`;
}

async function telegramApi(methodName, payload, env) {
  try {
    const response = await fetch(telegramApiUrl(methodName, env), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return response.json();
  } catch (_error) {
    return { ok: false };
  }
}

async function sendText(chatId, text, env) {
  await telegramApi(
    "sendMessage",
    {
      chat_id: chatId,
      text,
    },
    env
  );
}

async function registerWebhook(url, env) {
  const webhookUrl = `${url.protocol}//${url.host}${WEBHOOK_PATH}`;
  const result = await telegramApi(
    "setWebhook",
    {
      url: webhookUrl,
      secret_token: env.ENV_BOT_SECRET,
    },
    env
  );

  return new Response(result.ok ? "OK" : JSON.stringify(result, null, 2), {
    status: result.ok ? 200 : 500,
  });
}

async function unregisterWebhook(env) {
  const result = await telegramApi(
    "setWebhook",
    {
      url: "",
    },
    env
  );

  return new Response(result.ok ? "OK" : JSON.stringify(result, null, 2), {
    status: result.ok ? 200 : 500,
  });
}
