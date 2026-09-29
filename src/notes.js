import { json } from './util.js';
import {
  getConversation, getMessage, prevUserMessage, updateMessage,
  getEnabledMcpServers,
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

  const found = await findNoteServer(env, userId);
  if (!found) {
    return json({ error: `没找到带 ${NOTE_TOOL} 工具的 MCP：先在设置里添加笔记服务并启用` }, 400);
  }

  const asked = (await prevUserMessage(env.DB, conversationId, messageId)) || conv.title;
  const settings = await readSettings(env.DB, userId);
  const note = buildNote({ asked, answer, msg, conv, sources: toolSources(msg.meta) });

  try {
    const r = await callTool(found.server, NOTE_TOOL, {
      title: note.title, tags: note.tags, content: note.content, agent: settings.appName,
    });
    // 笔记服务把业务错误包在正常返回里（和 Tavily 一个毛病），得看文本判断
    const fail = /^(错误|error)/i.test((r.text || '').trim());
    if (fail) return json({ error: (r.text || '').slice(0, 200) }, 502);
  } catch (err) {
    return json({ error: `收藏失败：${err?.message || err}` }, 502);
  }

  const meta = parseMeta(msg.meta);
  meta.note = { title: note.title, at: Date.now() };
  await updateMessage(env.DB, messageId, {
    content: msg.content, status: msg.status, meta: JSON.stringify(meta),
  });

  return json({ ok: true, title: note.title });
}

// 一键收藏没有模型参与，标题取本轮提问、标签固定，正文把问答和来源拼全
function buildNote({ asked, answer, msg, conv, sources }) {
  const head = `问：${asked}\n\n${answer}`;
  const foot = [
    sources?.length ? `\n\n参考来源：\n${sources.map((s) => `- ${s.title || s.url} ${s.url}`).join('\n')}` : '',
    `\n\n—— 来自 ${conv.model || '未知模型'} 的回答 · ${new Date(msg.created_at).toLocaleString('zh-CN')}`,
  ].join('');
  return {
    title: clip(asked, 28) || 'AI 回答收藏',
    tags: 'AI对话,收藏',
    content: (head + foot).slice(0, 20_000),
  };
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

// 回答里的来源存在那条消息的 meta.tools 里，笔记带上才可追溯
function toolSources(metaText) {
  const out = [];
  for (const t of parseMeta(metaText).tools ?? []) {
    for (const s of t.sources ?? []) if (s?.url) out.push(s);
  }
  return out.slice(0, 8);
}

function parseMeta(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

function clip(s, n) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) : t;
}
