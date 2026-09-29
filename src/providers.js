import { json } from './util.js';
import { validateBaseUrl } from './sanitize.js';
import {
  listProviders, getProvider, insertProvider, updateProvider, deleteProvider,
  disableAll, enableOne, clearProviderRef, newId,
} from './db.js';

// Key 只写不读：对外一律打码，明文只存在于 D1 行里（§7.3）
function mask(row) {
  const { api_key: key, ...rest } = row;
  return { ...rest, apiKeyMasked: key ? `sk-…${key.slice(-4)}` : '', hasKey: !!key };
}

function pickFields(body, existing) {
  const s = (k, d) => (typeof body?.[k] === 'string' && body[k] !== '' ? body[k] : (existing?.[k] ?? d));
  const n = (k, d) => (Number.isFinite(Number(body?.[k])) && body[k] !== '' && body[k] != null
    ? Number(body[k]) : (existing?.[k] ?? d));
  return {
    name: s('name'),
    protocol: 'openai-compatible',           // 第一版只有一种（§12.1 #11）
    base_url: s('baseUrl'),
    model: s('model'),
    extra_headers: body?.extraHeaders ? JSON.stringify(body.extraHeaders) : (existing?.extra_headers ?? null),
    max_input_tokens: n('maxInputTokens', null),
    max_output_tokens: n('maxOutputTokens', null),
  };
}

export async function handleListProviders(env, userId) {
  const rows = await listProviders(env.DB, userId);
  return json({ providers: rows.map(mask) });
}

export async function handleSaveProvider(request, env, userId, id) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: '请求体不是合法 JSON' }, 400);

  const existing = id ? await getProvider(env.DB, userId, id) : null;
  if (id && !existing) return json({ error: '供应商不存在' }, 404);

  const f = pickFields(body, existing);
  if (!f.name || !f.base_url || !f.model) {
    return json({ error: '名称、Base URL、模型名都要填' }, 400);
  }

  const check = validateBaseUrl(f.base_url);
  if (!check.ok) return json({ error: `Base URL 被拒绝：${check.reason}` }, 400);

  // 留空表示"不改"，编辑时不必重新粘一遍 Key
  const key = typeof body.apiKey === 'string' && body.apiKey
    ? body.apiKey : existing?.api_key;
  if (!key) return json({ error: '首次保存必须提供 API Key' }, 400);

  const row = {
    id: id ?? newId('pv'),
    user_id: userId,
    name: f.name, protocol: f.protocol, base_url: f.base_url.replace(/\/$/, ''),
    api_key: key, model: f.model, extra_headers: f.extra_headers,
    is_enabled: existing?.is_enabled ?? 0,
    created_at: existing?.created_at ?? Date.now(),
    max_input_tokens: f.max_input_tokens, max_output_tokens: f.max_output_tokens,
  };

  if (id) await updateProvider(env.DB, row);
  else await insertProvider(env.DB, row);

  return json({ provider: mask(row), warning: check.insecure ? '该地址是明文 HTTP，链路不加密' : null });
}

export async function handleEnableProvider(env, userId, id) {
  if (!(await getProvider(env.DB, userId, id))) return json({ error: '供应商不存在' }, 404);
  await disableAll(env.DB, userId);
  await enableOne(env.DB, userId, id);
  return json({ ok: true });
}

export async function handleDeleteProvider(env, userId, id) {
  await deleteProvider(env.DB, userId, id);
  await clearProviderRef(env.DB, userId, id);
  return json({ ok: true });
}

// 连通性测试：真发一条极短请求，也顺带回答"Cloudflare 边缘能不能够到这台机器"
export async function handleTestProvider(env, userId, id) {
  const p = await getProvider(env.DB, userId, id);
  if (!p) return json({ error: '供应商不存在' }, 404);
  const check = validateBaseUrl(p.base_url);
  if (!check.ok) return json({ ok: false, error: check.reason });

  const started = Date.now();
  try {
    const res = await fetch(`${p.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${p.api_key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: p.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1, stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const ms = Date.now() - started;
    if (!res.ok) {
      return json({ ok: false, status: res.status, ms, error: text.slice(0, 300) });
    }
    return json({ ok: true, status: res.status, ms });
  } catch (err) {
    return json({ ok: false, ms: Date.now() - started, error: err?.name === 'TimeoutError'
      ? '30 秒超时：Cloudflare 边缘连不上这个地址' : String(err?.message || err) });
  }
}
