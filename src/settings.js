import { json } from './util.js';
import { getSettings, putSettings } from './db.js';

// 这些开关的真源在 D1，localStorage 只是「登录页拿到 token 之前也得有个值」的缓存。
// 换设备、换浏览器登录进来，设置应该和原来那台一模一样。
export const DEFAULT_SETTINGS = {
  appName: '狗蛋',
  accent: 'blue',
  // auto = 不写 data-theme，交给系统的深浅色偏好
  theme: 'auto',
  net: true,
  tts: false,
  voice: 'zh-CN-XiaoxiaoNeural',
  hint: false,
  regen: false,
};

const ACCENTS = new Set(['blue', 'violet', 'teal', 'green', 'amber', 'rose']);
const THEMES = new Set(['auto', 'light', 'dark']);
const BOOLS = new Set(['net', 'tts', 'hint', 'regen']);

function pick(stored) {
  const out = {};
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) out[key] = stored[key] ?? def;
  return out;
}

// data 里还存着服务端的 prunedAt 之类，只挑上面这些键下发
export async function readSettings(db, userId) {
  return pick(parseJson((await getSettings(db, userId))?.data));
}

export async function handleGetSettings(env, userId) {
  return json({ settings: await readSettings(env.DB, userId) });
}

export async function handlePutSettings(request, env, userId) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: '请求体不是合法 JSON' }, 400);

  const stored = parseJson((await getSettings(env.DB, userId))?.data);
  const next = { ...stored };

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!(key in body)) continue;
    const v = body[key];
    if (key === 'appName') {
      // 上限 24 字：这个名字要进侧栏、标题栏、空状态问候和登录页，太长会把布局挤坏
      const name = typeof v === 'string' ? v.trim() : '';
      if (!name || name.length > 24) return json({ error: '名称要 1–24 个字' }, 400);
      next.appName = name;
    } else if (key === 'accent') {
      if (!ACCENTS.has(v)) return json({ error: '没有这套配色' }, 400);
      next.accent = v;
    } else if (key === 'theme') {
      if (!THEMES.has(v)) return json({ error: '深浅色只能是 auto / light / dark' }, 400);
      next.theme = v;
    } else if (key === 'voice') {
      if (typeof v !== 'string' || !v || v.length > 64) return json({ error: '音色名不合法' }, 400);
      next.voice = v;
    } else if (BOOLS.has(key)) {
      if (typeof v !== 'boolean') return json({ error: '开关只能是开或关' }, 400);
      next[key] = v;
    }
  }

  await putSettings(env.DB, userId, JSON.stringify(next), Date.now());
  return json({ settings: pick(next) });
}

function parseJson(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}
