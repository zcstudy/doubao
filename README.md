# doubao — 自托管 AI 聊天站（Cloudflare Pages + Functions + D1）

一个单用户的 AI 聊天网页：界面照豆包做，模型走任意 OpenAI 兼容端点（自建 vLLM / llama.cpp 都行），
联网搜索和笔记收藏走远程 MCP，全部状态放在 Cloudflare D1。免域名、免服务器，免费额度够用。

在线地址：<https://doubao-5jj.pages.dev>

## 功能

- **流式对话**：具名 SSE 事件（`meta / reasoning / text / tool_start / tool_retry / tool_done / tool_error / notice / error / done`），思考模型的思维链单独折叠显示
- **多模态**：粘贴 / 拖拽 / 选图，一次最多 4 张；前端压到长边 1280 的 JPEG 再上传，追问时自动带上上一轮的图
- **联网搜索**：MCP 客户端，可挂多个远程 MCP 服务，模型自主决定调用，工具卡片显示参数、状态和来源链接
- **收藏到笔记**：每条回答一键推送到笔记 MCP 的收件箱，带来源和模型信息
- **导出 Word / PDF**：每条回答一键转文档，正文走 Pandoc 类 MCP 服务转换；文件字节由服务端带令牌取回再以附件下发，浏览器只拿文件、拿不到令牌
- **朗读**：Edge 在线 TTS（浏览器直连），非 Edge 内核自动退回系统 `speechSynthesis`
- **会话管理**：重命名 / 删除 / 编辑重发 / 重新生成 / 导出 Markdown 与 JSON，刷新后工具卡片与思考过程照样还原
- **应用名可自定义**，深浅色跟随系统，移动端自适应
- **口令登录**：单用户访问口令 + HMAC token，模型与 MCP 的 Key 只存 D1、只写不读，接口一律打码返回

## 架构

```text
浏览器  ──▶  Cloudflare Pages（静态 index.html）
                │  /api/* 交给 _worker.js（Pages Functions 高级模式）
                ▼
        Cloudflare D1（SQLite）  ── providers / mcp_servers / conversations / messages / app_settings
                │
                ├──▶ 模型端点（OpenAI 兼容 /chat/completions，流式）
                └──▶ 远程 MCP 服务（streamable HTTP）
```

前端是**一个 HTML 文件**（`public/index.html`，无框架、无构建步骤），后端是 `src/` 下的 ES 模块，
用 esbuild 打成自包含的 `dist/_worker.js`。

## 部署

```bash
npm install
npx wrangler login                                  # 浏览器 OAuth，不需要手填任何凭据
npx wrangler d1 create ai-chat-db                   # 把输出的 database_id 填进 wrangler.jsonc
npx wrangler d1 execute ai-chat-db --remote --file=migrations/0000_init_schema.sql
npx wrangler d1 execute ai-chat-db --remote --file=migrations/0001_provider_token_limits.sql
npx wrangler d1 execute ai-chat-db --remote --file=migrations/0002_message_images_meta.sql
npx wrangler d1 execute ai-chat-db --remote --file=migrations/0003_settings.sql

npx wrangler pages secret put ACCESS_PASSWORD --project-name doubao   # 访问口令
npx wrangler pages secret put TOKEN_SECRET   --project-name doubao    # token 签名密钥，随机长字符串
npx wrangler pages secret put MODELSCOPE_TOKEN --project-name doubao  # 可选：导出 Word/PDF 用，魔搭 SDK 令牌 ms-xxxx
npx wrangler pages project create doubao --production-branch main

npm run build && npx wrangler pages deploy dist --project-name doubao
```

本地联调：复制 `.dev.vars.example` 为 `.dev.vars` 填上口令与密钥，然后 `npm run dev`
（`wrangler pages dev dist` 会从 `wrangler.jsonc` 读 D1 绑定，**不要**再手动传 `--d1`，
否则会连到一个新建的空 sqlite，报 `no such table`）。

## 目录

```text
src/index.js        路由与鉴权
src/chat.js         /api/chat：SSE 事件流、工具循环、落盘
src/mcp.js          远程 MCP 客户端（initialize / tools/list / tools/call + 工具缓存 + schema 瘦身）
src/db.js           D1 访问层：所有查询都带 user_id 且命中索引，id 一律 bind
src/providers.js    供应商 CRUD（Key 只写不读，返回 sk-…last4）
src/mcp-servers.js  MCP 服务 CRUD / 开关 / 连通测试
src/conversations.js会话、消息、回退
src/notes.js        收藏到笔记（找带 add_note 工具的 MCP 去调）
src/export.js       导出 Word/PDF（调 markdown 转文档的 MCP，再带令牌把文件取回来）
src/settings.js     应用级设置（目前只有名称）
src/auth.js         口令校验与 HMAC token
src/sanitize.js     出站地址校验（挡内网 / 元数据地址）
public/index.html   整个前端
```

## 实测踩过的坑（都写进代码注释了）

- **图片必须转 JPEG**：部分视觉模型后端收到 `data:image/webp` 会直接 `400 Failed to load image`
- **`request.signal` 在 Pages 上不一定触发**：客户端断开后服务端仍会把这条写完，所以「停止」按钮的语义是停止显示
- **落盘要放在响应之后**（`ctx.waitUntil`）：否则用户中途关页面，这半截回答就没了
- **回退删除按 `rowid` 而不是时间戳**：同一毫秒会写进多条消息，按 `created_at` 会误删
- **D1 免费额度按行读写计**：所以组装上下文的查询故意不 `select images / meta`，历史图片一条就几百 KB
- **Edge TTS 的 `Sec-MS-GEC` 校验的是 `User-Agent`**，Workers 不能自定义 WS 请求头，只能在浏览器里直连
- **`*.pages.dev` 的短名全局唯一**：撞名时 Cloudflare 静默加后缀（本项目 `doubao` → `doubao-5jj`）
- **ModelScope Studio 的 `*.ms.show` 域名拒绝匿名与 SDK 直连**（整站 403），生成的文件要改写成同名的 `studio-*.api-inference.modelscope.net` 并带上 `Authorization: Bearer $MODELSCOPE_TOKEN` 才取回来
- **MCP 的 `inputSchema` 会把整篇示例塞进 `default`**（有个转换工具光默认值就 2KB），喂给模型前必须剥掉，否则每轮都白烧输入 token

## 许可

暂未指定。
