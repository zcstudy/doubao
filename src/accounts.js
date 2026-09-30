import { json } from './util.js';
import { checkPassword, signToken } from './auth.js';
import { adoptLegacyData, countUsers, getUser, insertUser, updateUserPassword } from './db.js';

const DAY = 86_400_000;
const PHONE = /^1[3-9]\d{9}$/;
const MAX_BODY = 16 * 1024;

// 访问口令管「能不能进门」，手机号 + 密码管「进门之后是谁」。
// 注册同样要输对口令：口令就是这个系统的建号门槛，没有口令谁也建不出账号。
export async function handleRegister(request, env) {
  const c = await readCreds(request);
  if (!c) return json({ error: '请求体不是合法 JSON' }, 400);
  if (!PHONE.test(c.phone)) return json({ error: '手机号格式不对' }, 400);
  if (c.password.length < 6 || c.password.length > 64) return json({ error: '密码要 6–64 位' }, 400);
  if (!(await checkPassword(c.accessPassword, env))) return json({ error: '访问口令不正确' }, 401);

  if (await getUser(env.DB, c.phone)) return json({ error: '这个手机号已经注册过了，直接登录' }, 409);

  // 第一个号把单用户版留下的历史接走，后来的号各起各的
  const isFirst = (await countUsers(env.DB)) === 0;
  await insertUser(env.DB, c.phone, c.password, Date.now());
  if (isFirst) await adoptLegacyData(env.DB, c.phone);

  return json({ token: await signToken(c.phone, env, 7 * DAY), userId: c.phone });
}

export async function handleLogin(request, env) {
  const c = await readCreds(request);
  if (!c) return json({ error: '请求体不是合法 JSON' }, 400);
  if (!(await checkPassword(c.accessPassword, env))) return json({ error: '访问口令不正确' }, 401);

  const user = PHONE.test(c.phone) ? await getUser(env.DB, c.phone) : null;
  if (!user || user.password !== c.password) return json({ error: '手机号或密码不正确' }, 401);

  return json({ token: await signToken(user.phone, env, 7 * DAY), userId: user.phone });
}

// 已登录状态下改自己的密码。userId 由调用方从鉴权块传入，绝不从 body 取，防越权。
export async function handleChangePassword(request, env, userId) {
  const b = await request.json().catch(() => null);
  if (!b || typeof b.current !== 'string' || typeof b.next !== 'string') return json({ error: '请求体不是合法 JSON' }, 400);
  const current = b.current.trim(), next = b.next.trim();
  if (next.length < 6 || next.length > 64) return json({ error: '密码要 6–64 位' }, 400);
  const user = await getUser(env.DB, userId);
  if (!user || user.password !== current) return json({ error: '当前密码不正确' }, 403);
  await updateUserPassword(env.DB, userId, next);
  return json({ ok: true });
}

async function readCreds(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (!len || len > MAX_BODY) return null;
  const body = await request.json().catch(() => null);
  if (!body) return null;
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  return { phone: str(body.phone), password: str(body.password), accessPassword: str(body.accessPassword) };
}
