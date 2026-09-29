import { json } from './util.js';
import {
  getProvider, getEnabledProvider, insertConversation, insertMessage,
  loadHistory, touchConversation, updateMessage, newId,
  lastUserImages, rollbackFrom,
} from './db.js';
import { createAccumulator, feedJson, parseSSE } from './sse.js';
import { validateBaseUrl } from './sanitize.js';
import { getEnabledMcpServers } from './db.js';
import { listTools, toOpenAiTools, callTool } from './mcp.js';

const SYSTEM_PROMPT = '你是一个乐于助人的中文助手。回答准确、简洁。';
const SEARCH_PROMPT =
  '回答涉及近期信息、事实核查或外部资料时，先调用可用的搜索工具，再依据检索结果作答，'
  + '并在文末列出用到的来源链接。不要在还没有调用工具时声称已经搜索过。';
const HISTORY_CAP = 60;          // 粗略防超长：M1 先按条数截，M2 再按 token 预算
const MAX_TOOL_ROUNDS = 5;
// 一次对话里最多加载几个 MCP 服务的工具，超出的会点名提示
const MAX_MCP_SERVERS = 8;
// Tavily 一次返回 17KB 左右，原样回喂会挤掉上下文，留个预算
const TOOL_RESULT_CAP = 6000;
// dev Key 的速率限制按秒计，同轮连发必撞，退避一次基本能过
const RATE_RETRY_DELAY_MS = 2000;

// 图片相关上限。D1 免费层单行 2 MB、单条查询也有 2 MB 限制（§4.1），
// 所以一行里塞的 data URL 必须留出 INSERT 语句本身的余量
const MAX_BODY = 8 * 1024 * 1024;
const MAX_IMAGES = 4;
const MAX_IMAGE_LEN = 1_200_000;
const MAX_IMAGES_JSON = 1_600_000;
const DATA_IMAGE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;
// 存进 meta 的工具过程也要封顶，否则一行图片 + 一行工具日志会把行撑爆
const META_CAP = 100_000;

export async function handleChat(request, env, ctx, userId) {
  const body = await readJson(request);
  if (!body) return json({ error: '请求体过大或不是合法 JSON' }, 413);

  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const att = normalizeAttachments(body.attachments);
  if (att.error) return json({ error: att.error }, 400);
  // 纯图无文字是常见用法（"看看这张图"），重新生成则两者都没有，靠 rollbackTo 定位
  if (!content && !att.images.length && !body.regenerate) return json({ error: '消息内容为空' }, 400);
  if (body.regenerate && !body.conversationId) return json({ error: '重新生成需要已有会话' }, 400);

  const provider = body.providerId
    ? await getProvider(env.DB, userId, body.providerId)
    : await getEnabledProvider(env.DB, userId);
  if (!provider) return json({ error: '还没有可用的供应商，请先在设置里添加并启用一个' }, 400);

  // 保存时校验过一次不够：库里那行可能被别的途径改坏
  const check = validateBaseUrl(provider.base_url);
  if (!check.ok) return json({ error: `供应商地址不被允许：${check.reason}` }, 400);

  let conversationId = typeof body.conversationId === 'string' ? body.conversationId : null;
  const now = Date.now();
  if (conversationId) {
    const owned = await env.DB.prepare('SELECT id FROM conversations WHERE user_id = ? AND id = ?')
      .bind(userId, conversationId).first();
    if (!owned) return json({ error: '会话不存在' }, 404);
  } else {
    conversationId = newId('cv');
    await insertConversation(env.DB, {
      id: conversationId, user_id: userId,
      title: (content || '图片').slice(0, 30),
      provider_id: provider.id, model: provider.model,
      created_at: now, updated_at: now,
    });
  }

  // 编辑重发 / 重新生成：先回退到指定那条，再按新消息重新走一遍
  let rolledBack = 0;
  if (typeof body.rollbackTo === 'string' && body.rollbackTo) {
    rolledBack = await rollbackFrom(env.DB, conversationId, body.rollbackTo);
  }

  let userMsgId = null;
  if (!body.regenerate) {
    userMsgId = newId('ms');
    await insertMessage(env.DB, {
      id: userMsgId, conversation_id: conversationId, role: 'user',
      content, tool_calls: null, tool_call_id: null,
      name: null, status: 'done', created_at: Date.now(),
      images: att.json,
    });
  }

  const history = await loadHistory(env.DB, conversationId, HISTORY_CAP);
  // 本轮没带图就看看上一条用户消息带没带，好让"这张图里有什么"能追问下去
  const carried = !att.images.length ? await lastUserImages(env.DB, conversationId) : null;
  const imageMap = new Map();
  if (att.images.length && userMsgId) imageMap.set(userMsgId, att.images);
  if (carried?.id && carried.id !== userMsgId) imageMap.set(carried.id, carried.images);

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...toApiMessages(history, imageMap)];

  // 工具发现放在 pump 里做：MCP 冷启动握手可能要一秒以上，
  // 卡在这里会让前端迟迟收不到 meta。
  const search = { enabled: !!body.useSearch, tools: [], owners: new Map() };

  const assistantMsgId = newId('ms');
  const model = body.model || provider.model;

  // 先落一行空壳：客户端中途断开、或 Worker 被硬杀时，这条至少还在，
  // 刷新后能看到"被打断"的那半截而不是凭空消失（§5.7）
  await insertMessage(env.DB, {
    id: assistantMsgId, conversation_id: conversationId, role: 'assistant',
    content: '', tool_calls: null, tool_call_id: null,
    name: null, status: 'streaming', created_at: Date.now(),
  });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const send = (event, data) =>
    writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)).catch(() => {});

  const abort = new AbortController();
  request.signal.addEventListener('abort', () => abort.abort());

  const toolLog = [];
  ctx.waitUntil(
    pump({ abort, provider, model, messages, search, send, writer, toolLog,
      env, userId, conversationId, assistantMsgId })
  );

  send('meta', { conversationId, userMessageId: userMsgId, assistantMessageId: assistantMsgId,
    providerId: provider.id, providerName: provider.name, model, rolledBack });

  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
}

async function pump(s) {
  const total = { text: '', reasoning: '', usage: null, finishReason: null };
  const toolLog = s.toolLog;
  let status = 'done';
  let errorMsg = null;
  let rounds = 0;

  try {
    if (s.search.enabled) await prepareSearch(s);

    for (;;) {
      const acc = createAccumulator();
      await streamOnce(s, acc);

      total.text += acc.text;
      total.reasoning += acc.reasoning;
      if (acc.usage) total.usage = acc.usage;
      if (acc.finishReason) total.finishReason = acc.finishReason;

      const calls = acc.toolCalls.filter(Boolean);
      if (!calls.length || s.abort.signal.aborted) break;

      if (rounds >= MAX_TOOL_ROUNDS) {
        s.send('notice', { message: `工具调用已达 ${MAX_TOOL_ROUNDS} 轮上限，停止继续检索` });
        break;
      }
      rounds++;

      // 工具回合要按 OpenAI 的原样结构回喂，否则下一轮模型接不上
      s.messages.push({
        role: 'assistant',
        content: acc.text || '',
        tool_calls: calls.map((c) => ({
          id: c.id, type: 'function',
          function: { name: c.name, arguments: c.arguments || '{}' },
        })),
      });
      for (const c of calls) s.messages.push(await runTool(s, c));
    }
  } catch (err) {
    if (s.abort.signal.aborted) { status = 'aborted'; }
    else { status = 'error'; errorMsg = err?.message || String(err); }
  }

  // 落盘放在响应之后：客户端断开时这段仍会跑完（§5.7）
  const meta = buildMeta(toolLog, total.reasoning, rounds);
  try {
    await updateMessage(s.env.DB, s.assistantMsgId, { content: total.text, status, meta });
    await touchConversation(s.env.DB, s.userId, s.conversationId, Date.now());
  } catch (err) {
    errorMsg = errorMsg || `写入失败：${err?.message}`;
  }

  if (errorMsg) s.send('error', { message: errorMsg });
  s.send('done', {
    finishReason: total.finishReason, status, rounds,
    usage: total.usage, reasoning: total.reasoning.length,
  });
  try { await s.writer.close(); } catch { /* 客户端已断开 */ }
}

// 工具过程存成 JSON，刷新后还能还原卡片；预览太长就整段丢弃只留骨架
function buildMeta(toolLog, reasoning, rounds) {
  if (!toolLog.length && !reasoning) return null;
  const brief = toolLog.map((t) => ({ ...t, preview: t.preview ? t.preview.slice(0, 600) : undefined }));
  let obj = { rounds, reasoning: reasoning.slice(0, 8000), tools: brief };
  let text = JSON.stringify(obj);
  if (text.length > META_CAP) {
    obj = { rounds, reasoning: reasoning.slice(0, 2000), tools: brief.map((t) => ({ ...t, preview: undefined })) };
    text = JSON.stringify(obj);
  }
  return text.length > META_CAP ? JSON.stringify({ rounds }) : text;
}

// 拉取各 MCP 服务的工具清单，拼成 OpenAI 的 tools
async function prepareSearch(s) {
  s.messages[0].content += '\n' + SEARCH_PROMPT;
  const all = await getEnabledMcpServers(s.env.DB, s.userId);
  const servers = all.slice(0, MAX_MCP_SERVERS);
  if (all.length > servers.length) {
    s.send('notice', {
      message: `启用了 ${all.length} 个 MCP 服务，本次只加载前 ${MAX_MCP_SERVERS} 个（未使用：`
        + `${all.slice(MAX_MCP_SERVERS).map((x) => x.name).join('、')}）。工具太多会挤占上下文，也更容易让模型选错`,
    });
  }

  // 串行握手最坏要十几秒（冷 isolate 单家就 11s），并行后只取决于最慢的一家
  const settled = await Promise.allSettled(servers.map((server) => listTools(server)));
  const warnings = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      for (const t of r.value) {
        s.search.owners.set(t.name, servers[i]);
        s.search.tools.push(...toOpenAiTools([t]));
      }
    } else warnings.push(`${servers[i].name}：${r.reason?.message || r.reason}`);
  });

  if (!servers.length) {
    s.send('notice', { message: '已开启联网，但没有启用中的 MCP 搜索服务，本次按离线回答' });
  } else if (warnings.length) {
    s.send('notice', { message: `部分联网服务未能加载 —— ${warnings.join('；')}` });
  }
}

async function runTool(s, call) {
  const args = parseArgs(call.arguments);
  s.send('tool_start', { callId: call.id, name: call.name, args });
  const log = { callId: call.id, name: call.name, args, status: 'running' };
  s.toolLog.push(log);

  const server = s.search.owners.get(call.name);
  if (!server) {
    const message = `未找到工具 ${call.name}`;
    s.send('tool_error', { callId: call.id, message });
    Object.assign(log, { status: 'error', message });
    return { role: 'tool', tool_call_id: call.id, content: message };
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const r = await callTool(server, call.name, args);
      s.send('tool_done', {
        callId: call.id, ok: true, sources: r.sources,
        preview: truncate(r.text, TOOL_RESULT_CAP),
      });
      Object.assign(log, { status: 'done', sources: r.sources, preview: truncate(r.text, 2000) });
      return { role: 'tool', tool_call_id: call.id, content: truncate(r.text, TOOL_RESULT_CAP) };
    } catch (err) {
      // Tavily 的 dev Key 对同轮连发很敏感，等一秒多再打一次通常就过了
      if (attempt === 0 && !s.abort.signal.aborted && isRateLimit(err)) {
        s.send('tool_retry', { callId: call.id, message: '被限流，重试中…' });
        await sleep(RATE_RETRY_DELAY_MS);
        continue;
      }
      // 错误也要回喂：模型不知道失败会一直重试同一个查询
      const message = `工具调用失败：${err?.message || err}`;
      s.send('tool_error', { callId: call.id, ok: false, message });
      Object.assign(log, { status: 'error', message });
      return { role: 'tool', tool_call_id: call.id, content: message };
    }
  }
}

function truncate(text, max) {
  return text.length > max ? text.slice(0, max) + '\n…（结果过长，已截断）' : text;
}

function isRateLimit(err) {
  return /429|excessive requests|too many requests|rate.?limit/i.test(err?.message || String(err));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function streamOnce(s, acc) {
  const upstream = await fetch(`${s.provider.base_url.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${s.provider.api_key}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...parseJson(s.provider.extra_headers, {}),
    },
    body: JSON.stringify({
      model: s.model,
      messages: s.messages,
      stream: true,
      ...(s.search.tools.length ? { tools: s.search.tools } : {}),
      ...(s.provider.max_output_tokens ? { max_tokens: s.provider.max_output_tokens } : {}),
    }),
    signal: s.abort.signal,
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    throw new Error(`上游返回 ${upstream.status}${text ? '：' + clip(text) : ''}`);
  }
  // 真透传在这里不成立：这个模型有 reasoning_content 需要拆出来，
  // 而且下行协议是具名事件，必须逐块解析后重发。
  await parseSSE(upstream.body, (ev) => {
    if (ev.type !== 'data') return;
    const d = feedJson(ev.payload, acc);
    if (d.reasoning) s.send('reasoning', { delta: d.reasoning });
    if (d.text) s.send('text', { delta: d.text });
  });
}

function parseArgs(text) {
  const j = parseJson(text, null);
  return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
}

// 带图的那条消息要发数组形式的 content，OpenAI 多模态规范就是这么定的
function toApiMessages(rows, imageMap) {
  const out = [];
  for (const r of rows) {
    if (r.role !== 'user' && r.role !== 'assistant') continue;
    if (r.status === 'error' && !r.content) continue;
    const images = imageMap?.get(r.id);
    out.push({
      role: r.role,
      content: images?.length
        ? [{ type: 'text', text: r.content || '请结合图片回答。' },
           ...images.map((url) => ({ type: 'image_url', image_url: { url } }))]
        : (r.content ?? ''),
    });
  }
  return out;
}

function normalizeAttachments(raw) {
  if (!Array.isArray(raw) || !raw.length) return { images: [], json: null };
  if (raw.length > MAX_IMAGES) return { error: `一次最多上传 ${MAX_IMAGES} 张图片` };
  const images = [];
  for (const item of raw) {
    const url = typeof item === 'string' ? item : item?.url;
    if (typeof url !== 'string') return { error: '图片格式不正确' };
    if (!DATA_IMAGE.test(url)) return { error: '只接受 png / jpeg / webp / gif 的 base64 图片' };
    if (url.length > MAX_IMAGE_LEN) return { error: '单张图片过大（压缩后仍超过 1.2 MB）' };
    images.push(url);
  }
  const json = JSON.stringify(images);
  if (json.length > MAX_IMAGES_JSON) return { error: '图片总体积超过 1.6 MB，请减少张数' };
  return { images, json };
}

function parseJson(text, fallback) {
  try { return JSON.parse(text) ?? fallback; } catch { return fallback; }
}

function clip(s) {
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  // 图片是 base64 塞在 JSON 里的，上限必须比纯文本请求高一档
  if (!len || len > MAX_BODY) return null;
  try { return await request.json(); } catch { return null; }
}
