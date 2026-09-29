import { json } from './util.js';
import {
  getConversation, getMessage, prevUserMessage, getEnabledMcpServers,
} from './db.js';
import { listTools, callTool } from './mcp.js';

const DOC_TOOL = 'markdown_to_document';
const FORMATS = { DOCX: 'docx', PDF: 'pdf' };
const MIME = {
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  PDF: 'application/pdf',
};

// 记住上次命中的服务，导出才不用每次都重握手（冷 isolate 单家能到十几秒）
let docServerId = null;

// 回答下面「导出 → Word/PDF」：把这条消息的 Markdown 交给转换服务，
// 文件字节由服务端取回来再吐给浏览器——服务给的直链是匿名 403 的，前端点不开
export async function handleExportDoc(request, env, userId) {
  const body = await request.json().catch(() => null);
  const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';
  const messageId = typeof body?.messageId === 'string' ? body.messageId : '';
  const format = String(body?.format || 'DOCX').toUpperCase();
  if (!conversationId || !messageId) return json({ error: '缺少 conversationId / messageId' }, 400);
  if (!FORMATS[format]) return json({ error: '只支持 DOCX 或 PDF' }, 400);

  const conv = await getConversation(env.DB, userId, conversationId);
  if (!conv) return json({ error: '会话不存在' }, 404);
  const msg = await getMessage(env.DB, conversationId, messageId);
  if (!msg) return json({ error: '消息不存在' }, 404);

  const answer = (msg.content || '').trim();
  if (!answer) return json({ error: '这条消息没有正文' }, 400);
  if (!env.MODELSCOPE_TOKEN) {
    return json({ error: '服务端还没配 MODELSCOPE_TOKEN，无法取回生成的文件' }, 500);
  }

  const found = await findDocServer(env, userId);
  if (!found) return json({ error: `没找到带 ${DOC_TOOL} 工具的 MCP：先在设置里添加文档导出服务并启用` }, 400);

  const asked = (await prevUserMessage(env.DB, conversationId, messageId)) || conv.title || '导出';
  const markdown = buildDoc({ asked, answer, msg, conv });

  let fileUrl;
  try {
    const r = await callTool(found.server, DOC_TOOL, {
      markdown_content: markdown,
      output_format: format,
    });
    fileUrl = pickFileUrl(r.text, format);
    if (!fileUrl) throw new Error('服务没回文件地址：' + (r.text || '').slice(0, 160));
  } catch (err) {
    return json({ error: `导出失败：${err?.message || err}` }, 502);
  }

  const target = fileFetchUrl(fileUrl);
  if (!target) return json({ error: `文件地址不在允许的域名里：${fileUrl.slice(0, 120)}` }, 502);

  let res;
  try {
    res = await fetch(target, {
      headers: { authorization: 'Bearer ' + env.MODELSCOPE_TOKEN },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return json({ error: `取回文件失败：${err?.message || err}` }, 502);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    return json({ error: `取回文件失败：HTTP ${res.status} ${detail}` }, 502);
  }

  const name = `${clip(asked, 24) || 'AI回答'}.${FORMATS[format]}`;
  return new Response(await res.arrayBuffer(), {
    headers: {
      'content-type': MIME[format],
      'content-disposition': `attachment; filename="doc.${FORMATS[format]}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'no-store',
    },
  });
}

// 标题取本轮提问，正文原样带 Markdown，末尾补一行出处
function buildDoc({ asked, answer, msg, conv }) {
  const foot = `\n\n---\n\n> 来自 ${conv.model || '未知模型'} 的回答 · ${new Date(msg.created_at).toLocaleString('zh-CN')}`;
  return `# ${clip(asked, 60) || 'AI 回答'}\n\n${answer}${foot}`.slice(0, 20_000);
}

// 工具回的是几段文本，第一段就是文件直链
function pickFileUrl(text, format) {
  const ext = FORMATS[format];
  const urls = (text || '').match(/https?:\/\/\S+/g) ?? [];
  return urls.find((u) => u.toLowerCase().includes('.' + ext)) ?? urls[0] ?? null;
}

// ModelScope 把 Studio 同时挂在 *.ms.show（拒绝匿名与 SDK 直连）和
// studio-*.api-inference.modelscope.net（认 token）两个域名上，只走后者
function fileFetchUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (/\.ms\.show$/.test(url.hostname)) {
    url.hostname = `studio-${url.hostname.slice(0, -'.ms.show'.length)}.api-inference.modelscope.net`;
  }
  if (!/(^|\.)api-inference\.modelscope\.net$/.test(url.hostname)) return null;
  url.protocol = 'https:';
  return url.toString();
}

async function findDocServer(env, userId) {
  const servers = await getEnabledMcpServers(env.DB, userId);
  const ordered = [...servers].sort((a, b) => rank(b) - rank(a));
  if (docServerId) ordered.sort((a, b) => (a.id === docServerId ? -1 : 0) - (b.id === docServerId ? -1 : 0));

  for (const s of ordered) {
    try {
      const tools = await listTools(s);
      const tool = tools.find((t) => t.name === DOC_TOOL)
        ?? tools.find((t) => /markdown.*(doc|word|pdf)|(doc|word|pdf).*markdown/i.test(t.name));
      if (tool) {
        docServerId = s.id;
        return { server: s };
      }
    } catch { /* 这家没响应，继续找 */ }
  }
  return null;
}

function rank(s) {
  return /doc|word|pdf|文档|转换/i.test(`${s.name} ${s.url}`) ? 2 : 0;
}

function clip(s, n) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) : t;
}
