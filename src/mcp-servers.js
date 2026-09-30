import { json } from './util.js';
import { validateBaseUrl } from './sanitize.js';
import {
  listMcpServers, getMcpServer, insertMcpServer, updateMcpServer, deleteMcpServer, newId,
} from './db.js';
import { listTools, resetToolCache } from './mcp.js';

// headers 里通常就装着 Tavily Key，和供应商 Key 一样只写不读
function mask(row) {
  const { headers, ...rest } = row;
  const h = parseJson(headers, {});
  const auth = h.Authorization || h.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  return {
    ...rest,
    hasKey: !!token,
    keyMasked: token ? `${token.slice(0, 4)}…${token.slice(-4)}` : '',
  };
}

export async function handleListMcpServers(env, userId) {
  return json({ servers: (await listMcpServers(env.DB, userId)).map(mask) });
}

export async function handleSaveMcpServer(request, env, userId, id) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: '请求体不是合法 JSON' }, 400);

  const existing = id ? await getMcpServer(env.DB, userId, id) : null;
  if (id && !existing) return json({ error: 'MCP 服务不存在' }, 404);

  const name = str(body.name) ?? existing?.name;
  const url = str(body.url) ?? existing?.url;
  if (!name || !url) return json({ error: '名称和地址都要填' }, 400);

  const check = validateBaseUrl(url);
  if (!check.ok) return json({ error: `MCP 地址被拒绝：${check.reason}` }, 400);

  // 留空表示不改；填了新的才覆盖
  let headers = existing?.headers ?? null;
  if (typeof body.apiKey === 'string' && body.apiKey) {
    headers = JSON.stringify({ Authorization: 'Bearer ' + body.apiKey.trim() });
  } else if (body.apiKey === '') {
    headers = null;
  }

  const row = {
    id: id ?? newId('mcp'),
    user_id: userId,
    name, transport: 'streamable-http', url,
    headers,
    tool_filter: Array.isArray(body.toolFilter) ? JSON.stringify(body.toolFilter) : (existing?.tool_filter ?? null),
    tool_aliases: body.toolAliases !== undefined ? cleanAliases(body.toolAliases) : (existing?.tool_aliases ?? null),
    is_enabled: existing?.is_enabled ?? 1,
    created_at: existing?.created_at ?? Date.now(),
  };

  if (id) { await updateMcpServer(env.DB, row); resetToolCache(id); }
  else await insertMcpServer(env.DB, row);

  return json({ server: mask(row), warning: check.insecure ? '该地址是明文 HTTP，链路不加密' : null });
}

export async function handleDeleteMcpServer(env, userId, id) {
  await deleteMcpServer(env.DB, userId, id);
  resetToolCache(id);
  return json({ ok: true });
}

export async function handleToggleMcpServer(env, userId, id, on) {
  const s = await getMcpServer(env.DB, userId, id);
  if (!s) return json({ error: 'MCP 服务不存在' }, 404);
  await updateMcpServer(env.DB, { ...s, is_enabled: on ? 1 : 0 });
  resetToolCache(id);
  return json({ ok: true, enabled: on });
}

// 真跑一遍 initialize + tools/list，把拿到的工具清单回给界面
export async function handleTestMcpServer(env, userId, id) {
  const s = await getMcpServer(env.DB, userId, id);
  if (!s) return json({ error: 'MCP 服务不存在' }, 404);
  const check = validateBaseUrl(s.url);
  if (!check.ok) return json({ ok: false, error: check.reason });

  const started = Date.now();
  try {
    const tools = await listTools(s, true);
    return json({ ok: true, ms: Date.now() - started,
      tools: tools.map((t) => ({ name: t.name, description: (t.description || '').slice(0, 160) })) });
  } catch (err) {
    return json({ ok: false, ms: Date.now() - started, error: shortErr(err) });
  }
}

function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }

// 别名只管界面显示，发给模型的工具名仍是 MCP 里的原名；空对象等于清空
function cleanAliases(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    const name = String(k).trim().slice(0, 64);
    const label = String(val).replace(/\s+/g, ' ').trim().slice(0, 24);
    if (name && label) out[name] = label;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}
function parseJson(s, d) { try { return typeof s === 'string' ? JSON.parse(s) : (s ?? d); } catch { return d; } }
function shortErr(e) {
  const m = e?.message || String(e);
  if (/TimeoutError|timeout/i.test(m)) return '30 秒超时：Cloudflare 边缘连不上这个地址';
  return m.length > 300 ? m.slice(0, 300) + '…' : m;
}
