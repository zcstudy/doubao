import { json } from './util.js';
import {
  getConversation, getMessage, updateMessage,
  getEnabledMcpServers, getEnabledProvider,
} from './db.js';
import { listTools, callTool } from './mcp.js';
import { readSettings } from './settings.js';

const NOTE_TOOL = 'add_note';

// 记住上次命中的服务，收藏就不用每次都把全部 MCP 握一遍手（冷的一家能到 10 秒）
let noteServerId = null;

export async function handleSaveNote(request, env, userId) {
  const body = await request.json().catch(() => null);
  const messageId = typeof body?.messageId === 'string' ? body.messageId : '';
  const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';
  if (!messageId || !conversationId) return json({ error: '缺少 messageId / conversationId' }, 400);

  const conv = await getConversation(env.DB, userId, conversationId);
  if (!conv) return json({ error: '会话不存在' }, 404);
  // 消息按 conversation_id 过滤后再取，别人的消息 id 传进来查不到
  const msg = await getMessage(env.DB, conversationId, messageId);
  if (!msg) return json({ error: '消息不存在' }, 404);

  const answer = (msg.content || '').trim();
  if (!answer) return json({ error: '这条消息没有正文' }, 400);
  if (msg.role !== 'assistant') return json({ error: '只能收藏模型的回答' }, 400);

  const found = await findNoteServer(env, userId);
  if (!found) {
    return json({ error: `没找到带 ${NOTE_TOOL} 工具的 MCP：先在设置里添加笔记服务并启用` }, 400);
  }

  const settings = await readSettings(env.DB, userId);
  // 笔记服务要求 title / tags 由调用方提炼，所以先让模型自己拟，拟不出来才兜底
  const { out: draft, why } = await draftMeta(env, userId, answer);
  const title = draft.title || fallbackTitle(answer);
  const tags = draft.tags || 'AI对话,收藏';

  try {
    // 正文只存模型输出原文，一字不改，也不拼用户提问
    const r = await callTool(found.server, NOTE_TOOL, {
      title, tags, content: answer.slice(0, 20_000), agent: settings.appName,
    });
    // 笔记服务把业务错误包在正常返回里（和 Tavily 一个毛病），得看文本判断
    const fail = /^(错误|error)/i.test((r.text || '').trim());
    if (fail) return json({ error: (r.text || '').slice(0, 200) }, 502);
  } catch (err) {
    return json({ error: `收藏失败：${err?.message || err}` }, 502);
  }

  const meta = parseMeta(msg.meta);
  meta.note = { title, tags, at: Date.now() };
  await updateMessage(env.DB, messageId, {
    content: msg.content, status: msg.status, meta: JSON.stringify(meta),
  });

  return json({ ok: true, title, tags, drafted: Boolean(draft.title), draftWhy: why });
}

const DRAFT_PROMPT =
  '你在为一条笔记提炼标题和标签。只输出一个 JSON 对象，不要解释、不要代码围栏。\n' +
  '格式：{"title":"…","tags":"词1,词2,词3"}\n' +
  'title：8–20 个字的名词短语，概括这条回答真正讲的是什么；不要出现日期、时间或「速记」「笔记」「总结」「AI 回答」这类占位词。\n' +
  'tags：3–6 个主题词，英文逗号分隔，词与词之间不要空格。';

// 提炼失败（没启用供应商、超时、返回不合法）不阻断收藏，走兜底标题
// why 只带状态码和截断后的原始文本，用于定位「拟不出来」的原因，不含密钥
async function draftMeta(env, userId, answer) {
  const provider = await getEnabledProvider(env.DB, userId);
  if (!provider) return { out: {}, why: 'no-provider' };
  let res;
  try {
    res = await fetch(`${provider.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${provider.api_key}`,
        'content-type': 'application/json',
        ...parseJson(provider.extra_headers, {}),
      },
      body: JSON.stringify({
        model: provider.model,
        stream: false,
        max_tokens: 600,
        messages: [
          { role: 'system', content: DRAFT_PROMPT },
          { role: 'user', content: answer.slice(0, 1500) },
        ],
      }),
      signal: AbortSignal.timeout(40_000),
    });
  } catch (e) {
    return { out: {}, why: `fetch:${e?.name || e?.message || e}` };
  }
  // why 只带状态码和模型自己写的原文，不回传上游错误体，免得把第三方信息透到浏览器
  if (!res.ok) return { out: {}, why: `http:${res.status}` };
  const j = await res.json().catch(() => null);
  const msg = j?.choices?.[0]?.message;
  const text = (msg?.content || msg?.reasoning_content || '');
  if (!text) return { out: {}, why: 'empty' };
  const out = sanitizeDraft(text);
  return { out, why: out.title ? 'ok' : `rejected:${text.slice(0, 120)}` };
}

function sanitizeDraft(text) {
  const m = (text || '').replace(/```/g, '').match(/\{[\s\S]*\}/);
  const j = m ? parseJson(m[0]) : null;
  const out = {};
  const title = typeof j?.title === 'string' ? j.title.replace(/\s+/g, ' ').trim() : '';
  // 服务侧要求 ≤30 字，提示词要 8–20；越界的直接判给兜底，别把半截话存进笔记
  if (title.length >= 5 && title.length <= 30 && !/\d{1,2}月|\d{1,2}:\d{2}|速记|笔记|总结/.test(title)) out.title = title;
  const tags = typeof j?.tags === 'string' ? j.tags : (Array.isArray(j?.tags) ? j.tags.join(',') : '');
  const list = tags.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 6);
  if (list.length >= 3) out.tags = list.join(',');
  return out;
}

// 兜底标题：取正文第一行有实义的文字，去掉 Markdown 记号
function fallbackTitle(answer) {
  const line = answer.split('\n')
    .map((s) => s.replace(/^[#>\-*\s]+/, '').replace(/[*_`]/g, '').trim())
    .find((s) => s.length >= 6) || 'AI 回答收藏';
  if (line.length <= 30) return line;
  const cut = line.slice(0, 30);
  // 英文词从中间截断很难看，退到最后一个完整词
  return cut.replace(/\s+\S*$/, '').trim() || cut.trim();
}

async function findNoteServer(env, userId) {
  const servers = await getEnabledMcpServers(env.DB, userId);
  const ordered = [...servers].sort((a, b) => rank(b) - rank(a));
  if (noteServerId) ordered.sort((a, b) => (a.id === noteServerId ? -1 : 0) - (b.id === noteServerId ? -1 : 0));

  for (const s of ordered) {
    try {
      const tools = await listTools(s);
      if (tools.some((t) => t.name === NOTE_TOOL)) {
        noteServerId = s.id;
        return { server: s };
      }
    } catch { /* 这家挂了或没响应，继续找下一家 */ }
  }
  return null;
}

function rank(s) {
  return /biji|note|笔记/i.test(`${s.name} ${s.url}`) ? 2 : 0;
}

function parseMeta(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

function parseJson(s, d) { try { return typeof s === 'string' ? JSON.parse(s) : (s ?? d); } catch { return d; } }
