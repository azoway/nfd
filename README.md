# Minimal NFD Worker

一个基于 Cloudflare Workers 的 Telegram 私聊转发机器人（精简版），核心能力如下：

- 消息转发：用户私聊消息转发给管理员
- 消息回复：管理员回复转发消息后，自动回传给原用户
- 屏蔽管理：支持 `/block`、`/unblock`、`/blocklist`
- 首次验证门槛：用户需先发送指定命令，验证后才能开始私聊

## 1. 功能说明

### 1.1 用户侧

- 首次私聊时，机器人会提示发送验证命令：`/verify <口令>`
- 口令正确后，写入允许名单，后续消息会被转发给管理员
- 若用户被屏蔽，会收到固定提示，消息不会转发

### 1.2 管理员侧

- 接收用户消息转发
- 回复任意转发消息：将回复内容回传给原用户
- 回复转发消息后发送：
  - `/block`：屏蔽该用户
  - `/unblock`：解除该用户屏蔽
- 直接发送 `/blocklist`：查看当前屏蔽列表
- 发送 `/help` 或 `/start`：查看命令说明

## 2. 项目文件

- `worker.js`：Worker 主逻辑（单文件）

## 3. 环境变量与 KV 绑定

在 Cloudflare Worker 中配置以下变量：

- `ENV_BOT_TOKEN`：Telegram Bot Token（来自 @BotFather）
- `ENV_BOT_SECRET`：Webhook secret token（任意高强度随机字符串）
- `ENV_ADMIN_UID`：管理员 Telegram 用户 ID
- `ENV_JOIN_CODE`：首次验证口令（例如 `my-pass-2026`）

KV 绑定：

- 绑定名称：`nfd`（代码中会使用 `env.nfd`）

## 4. 数据结构（KV）

- `allow:<uid> = 1`：用户已通过首次验证
- `block:<uid> = 1`：用户被屏蔽
- `map:<admin_message_id> = <guest_uid>`：管理员回复映射（带 TTL）

## 5. 部署步骤

1. 在 Cloudflare Workers 新建 Worker
2. 将 `worker.js` 内容粘贴部署
3. 配置环境变量和 KV 绑定（见上文）
4. 访问：
   - `https://<your-worker>.workers.dev/registerWebhook`
5. 返回 `OK` 表示 webhook 注册成功

可选接口：

- `GET /unregisterWebhook`：取消 webhook
- `GET /health`：健康检查

## 6. 使用建议

- 定期更换 `ENV_JOIN_CODE`，减少口令泄露风险
- 如果需要让已验证用户重新验证，可手动删除 KV 的 `allow:<uid>`
- `map:` 键包含 30 天 TTL，避免长期堆积

## 7. 注意事项

- 本项目只处理 Telegram 私聊（`chat.type === "private"`）
- 管理员指令中的 `/block`、`/unblock` 必须“回复一条转发消息”后执行
- `/blocklist` 最多返回前 200 条，避免消息过长

参考 https://github.com/LloydAsp/nfd
