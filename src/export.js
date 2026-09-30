import { json } from './util.js';
import {
  getConversation, getMessage, prevUserMessage, getEnabledMcpServers, getEnabledProvider,
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
  const markdown = buildDoc({ asked, answer });

  // 拟名字和转换并行跑：拟名字只是几百 token 的一次小调用，串在后面等于让用户多等两三秒
  const naming = draftFileName(env, userId, asked, answer);
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

  const base = (await naming) || docName(asked, conv.title);
  const name = `${base}.${FORMATS[format]}`;
  return new Response(await res.arrayBuffer(), {
    headers: {
      'content-type': MIME[format],
      'content-disposition': `attachment; filename="doc.${FORMATS[format]}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'no-store',
    },
  });
}

// 标题取本轮提问，正文原样带 Markdown。出处那一行（模型名 + 时间戳）已经去掉：
// 用户拿的是自己的笔记，不需要文件里再印一遍是谁答的、几点答的
function buildDoc({ asked, answer }) {
  return `# ${clip(asked, 60) || 'AI 回答'}\n\n${answer}`.slice(0, 20_000);
}

// 文件名不能是整句提问：冒号问号斜杠这些要么非法要么难看，而且太长看不出重点。
// 按符号把提问切成几段，取最长的那一段（一般是真正的主题，「帮我查一下」这种短前缀自然被丢掉）
const NOT_WORD = /[^\p{Script=Han}\p{L}\p{N}]+/u;

function docName(asked, fallback) {
  const parts = clauses(asked).length ? clauses(asked) : clauses(fallback);
  const best = parts.sort((a, b) => b.length - a.length)[0];
  return best ? Array.from(best).slice(0, 16).join('') : 'AI回答';
}

function clauses(s) {
  return String(s || '').split(NOT_WORD).filter((x) => x.length >= 2);
}

const NAME_PROMPT =
  '你在为一份要保存到磁盘的文档拟文件名。只输出文件名本身，不要解释、不要引号、不要扩展名。\n' +
  '要求：4–12 个字；只用汉字、英文字母和数字，一个标点、空格、斜杠、日期都不要出现；\n' +
  '概括这份文档真正讲的是什么；不要用「AI回答」「总结」「笔记」「文档」「报告」这类占位词。';

// 供应商没启用、超时、吐回来的东西不像名字——都不阻断导出，回空串让 docName() 兜底。
// 这个函数自己把异常吞干净：调用点在它 reject 之前可能先 return，会留一个 unhandled rejection
async function draftFileName(env, userId, asked, answer) {
  try {
    const provider = await getEnabledProvider(env.DB, userId);
    if (!provider) return '';
    const res = await fetch(`${provider.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${provider.api_key}`,
        'content-type': 'application/json',
        ...parseJson(provider.extra_headers, {}),
      },
      body: JSON.stringify({
        model: provider.model,
        stream: false,
        // 推理型模型 max_tokens 给小了只吐 reasoning_content，正文永远是空的
        max_tokens: 600,
        messages: [
          { role: 'system', content: NAME_PROMPT },
          { role: 'user', content: `【提问】${asked.slice(0, 200)}\n【回答】${answer.slice(0, 1200)}` },
        ],
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return '';
    const j = await res.json().catch(() => null);
    return cleanName(j?.choices?.[0]?.message?.content || '');
  } catch { return ''; }
}

// 只留汉字、字母和数字，最多 16 个：模型偶尔会带书名号、扩展名甚至一整句解释
function cleanName(s) {
  const t = String(s || '').replace(NOT_WORD, '').slice(0, 16);
  return t.length >= 2 ? t : '';
}

function parseJson(s, d) { try { return typeof s === 'string' ? JSON.parse(s) : (s ?? d); } catch { return d; } }

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
