const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const pad = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  );
}

export async function signToken(userId, env, ttlMs) {
  if (!env.TOKEN_SECRET) throw new Error('缺少 TOKEN_SECRET，请用 wrangler pages secret put 写入');
  const exp = Date.now() + ttlMs;
  const payload = b64url(enc.encode(JSON.stringify({ sub: userId, exp })));
  const sig = b64url(new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(env.TOKEN_SECRET), enc.encode(payload)),
  ));
  return `${payload}.${sig}`;
}

export async function verifyToken(token, env) {
  if (!token || !env.TOKEN_SECRET) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;

  const expected = b64url(new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(env.TOKEN_SECRET), enc.encode(payload)),
  ));
  if (!constantTimeEqualStr(sig, expected)) return null;

  try {
    const claims = JSON.parse(new TextDecoder().decode(unb64url(payload)));
    return typeof claims.exp === 'number' && claims.exp > Date.now() ? claims.sub : null;
  } catch {
    return null;
  }
}

// 口令比较走哈希后再比，避免直接对 secret 做逐字节比较带来的时序侧信道
export async function checkPassword(input, env) {
  if (!env.ACCESS_PASSWORD || typeof input !== 'string') return false;
  const [a, b] = await Promise.all([
    sha256(input),
    sha256(env.ACCESS_PASSWORD),
  ]);
  return constantTimeEqualStr(a, b);
}

async function sha256(text) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))));
}

function constantTimeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
