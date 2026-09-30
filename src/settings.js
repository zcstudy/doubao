import { json } from './util.js';
import { getSettings, putSettings } from './db.js';

export const DEFAULT_SETTINGS = { appName: '狗蛋' };

export async function readSettings(db, userId) {
  // 只把对外有意义的键返回：data 里还存着服务端的清理时间戳之类，不必下发
  const stored = parseJson((await getSettings(db, userId))?.data);
  return { ...DEFAULT_SETTINGS, appName: stored.appName || DEFAULT_SETTINGS.appName };
}

export async function handleGetSettings(env, userId) {
  return json({ settings: await readSettings(env.DB, userId) });
}

export async function handlePutSettings(request, env, userId) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: '请求体不是合法 JSON' }, 400);

  const stored = parseJson((await getSettings(env.DB, userId))?.data);
  const next = { ...stored };
  if ('appName' in body) {
    const name = typeof body.appName === 'string' ? body.appName.trim() : '';
    // 上限 24 字：这个名字要进侧栏、标题栏、空状态问候和登录页，太长会把布局挤坏
    if (!name || name.length > 24) return json({ error: '名称要 1–24 个字' }, 400);
    next.appName = name;
  }

  await putSettings(env.DB, userId, JSON.stringify(next), Date.now());
  return json({ settings: await readSettings(env.DB, userId) });
}

function parseJson(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}
