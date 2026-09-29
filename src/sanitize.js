// 出站地址校验（§7.5）。目标是拦住"让服务端去够内网"这件事本身，
// 而不是限制用户能连哪些公网服务——所以不做域名白名单。
const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal']);

export function validateBaseUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: '地址无法解析' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, reason: '只允许 http/https' };
  }
  if (u.username || u.password) {
    return { ok: false, reason: '地址里不要带账号密码' };
  }

  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: '目标是内网地址，已拒绝' };
  }
  // 主机名是 IP 字面量时才能可靠判内网；走域名的情况留给你自己负责
  if (looksLikeIpv4(host) && isPrivateIpv4(host)) {
    return { ok: false, reason: '目标是私有/链路本地/组播地址，已拒绝' };
  }
  if (isPrivateIpv6(host)) {
    return { ok: false, reason: '目标是 IPv6 本地地址，已拒绝' };
  }

  return { ok: true, insecure: u.protocol === 'http:' };
}

function looksLikeIpv4(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isPrivateIpv4(host) {
  const p = host.split('.').map(Number);
  if (p.some((n) => n > 255)) return true; // 畸形地址一律拒
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT
  if (a === 169 && b === 254) return true;             // 链路本地 / 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;                           // 组播 + 保留
  return false;
}

function isPrivateIpv6(host) {
  if (!host.includes(':')) return false;
  const h = host.toLowerCase();
  return h === '::1' || h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd');
}
