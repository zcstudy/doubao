// 远程 MCP 客户端（Streamable HTTP 传输）。
// 只在 Worker 侧用，前端永远拿不到 MCP 地址和 Key。

const TOOLS_TTL_MS = 5 * 60_000;
const toolCache = new Map();   // serverId -> {at, tools}

function headersFor(server) {
  const h = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  const cfg = parseJson(server.headers, {});
  if (cfg.Authorization) { h.authorization = cfg.Authorization; delete cfg.Authorization; }
  if (cfg.authorization) h.authorization = cfg.authorization;
  Object.assign(h, cfg);
  return h;
}

// 同一个端点可能回 JSON，也可能回 SSE 包裹的 JSON-RPC，两种都要认
async function rpc(server, method, params, id, sessionId) {
  const body = { jsonrpc: '2.0', id, method, params };
  const res = await fetch(server.url, {
    method: 'POST',
    headers: { ...headersFor(server), ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`MCP ${method} 失败：HTTP ${res.status} ${clip(await res.text().catch(() => ''))}`);
  const sid = res.headers.get('mcp-session-id');
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  const payload = ct.includes('event-stream') ? extractJsonRpc(text, id) : safeJson(text);
  if (payload?.error) throw new Error(`MCP ${method}：${payload.error.message || JSON.stringify(payload.error)}`);
  return { result: payload?.result, sessionId: sid };
}

function extractJsonRpc(sseText, id) {
  let fallback = null;
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const j = safeJson(line.slice(5).trim());
    if (!j) continue;
    if (j.id === id || j.id === String(id)) return j;
    fallback ??= j;
  }
  return fallback;
}

// 握手 + 列工具。拿到 mcp-session-id 就带上，没有就当无状态服务用
export async function listTools(server, force = false) {
  const hit = toolCache.get(server.id);
  if (!force && hit && Date.now() - hit.at < TOOLS_TTL_MS) return hit.tools;

  const init = await rpc(server, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'doubao', version: '0.1' },
  }, 1);
  const sid = init.sessionId;
  // initialized 通知没有 id，失败不该阻断主流程
  await fetch(server.url, {
    method: 'POST',
    headers: { ...headersFor(server), ...(sid ? { 'mcp-session-id': sid } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});

  const { result } = await rpc(server, 'tools/list', {}, 2, sid);
  let tools = result?.tools ?? [];
  const allow = parseJson(server.tool_filter, []);
  if (Array.isArray(allow) && allow.length) tools = tools.filter((t) => allow.includes(t.name));

  toolCache.set(server.id, { at: Date.now(), tools, sid });
  return tools;
}

// MCP 的 inputSchema 本来就是 JSON Schema，直接塞进 OpenAI 的 parameters 即可
export function toOpenAiTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: leanSchema(t.inputSchema || { type: 'object', properties: {} }),
    },
  }));
}

// 有些服务把整篇示例文档塞进 default（ModelScope 的 pandoc 工具光默认值就 2KB），
// 模型用不到默认值，每轮请求白烧输入
function leanSchema(v) {
  if (Array.isArray(v)) return v.map(leanSchema);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (k !== 'default') out[k] = leanSchema(x);
  return out;
}

export async function callTool(server, name, args) {
  const { result } = await rpc(server, 'tools/call', { name, arguments: args }, Date.now(),
    // 带上手握手的 session id：有些网关（ModelScope）是按 session 把调用路由到
    // 已经热起来的实例的，不带就可能连到一个冷实例上直接断连
    toolCache.get(server.id)?.sid ?? null);
  const parts = result?.content ?? [];
  const text = parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
  if (result?.isError) throw new Error(text || '工具返回错误');
  // 有些服务把上游的 HTTP 错误包成 200 + JSON 文本回过来（Tavily 限流就是这样）。
  // 不在这里认出来，卡片会显示"完成"，模型还会把它当正常检索结果引用。
  const bizError = businessError(text);
  if (bizError) throw new Error(bizError);
  return { text: text || '(空结果)', sources: pickSources(text) };
}

function businessError(text) {
  const j = safeJson(text);
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const badStatus = typeof j.status === 'number' && j.status >= 400 ? j.status : null;
  if (!j.error && !badStatus) return null;
  const detail = j.detail && typeof j.detail === 'object' ? j.detail.error : j.detail;
  const head = typeof j.error === 'string' ? j.error : (badStatus ? `HTTP ${badStatus}` : '工具返回错误');
  return detail ? `${head}（${detail}）` : head;
}

// 搜索结果是一段 JSON 字符串，把里面的 url/title 提出来给前端做来源链接
export function pickSources(text) {
  const out = [];
  const seen = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (typeof v.url === 'string' && /^https?:\/\//.test(v.url)) {
      if (!seen.has(v.url)) { seen.add(v.url); out.push({ url: v.url, title: v.title || hostOf(v.url) }); }
    }
    Object.values(v).forEach(walk);
  };
  const j = safeJson(text);
  if (j) walk(j);
  return out.slice(0, 8);
}

function hostOf(u) { try { return new URL(u).hostname; } catch { return u; } }
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
function parseJson(s, d) { const j = safeJson(s); return j ?? d; }
function clip(s) { return s.length > 200 ? s.slice(0, 200) + '…' : s; }

export function resetToolCache(id) { id ? toolCache.delete(id) : toolCache.clear(); }
