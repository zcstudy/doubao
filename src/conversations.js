import { json } from './util.js';
import {
  listConversations, getConversation, deleteConversation,
  renameConversation, loadMessagesForDisplay, rollbackFrom,
  pruneExpired, deleteAllConversations, getSettings, putSettings,
} from './db.js';

// 聊天记录在库里只留 10 天（本地 IndexedDB 缓存不受此限），清理最多每 12 小时跑一次
const RETENTION_MS = 10 * 86_400_000;
const PRUNE_INTERVAL_MS = 12 * 3_600_000;

export async function handleListConversations(env, userId) {
  await maybePrune(env, userId);
  return json({ conversations: await listConversations(env.DB, userId), retentionDays: RETENTION_MS / 86_400_000 });
}

// 没有 cron 可用（Pages Functions 不能被定时触发），所以搭在每次开站的列表请求上顺手清
// 清理失败绝不能连带把列表接口打挂，所以整段吞掉异常；标记按「尝试过」记，最坏 12 小时后再试
async function maybePrune(env, userId) {
  const row = await getSettings(env.DB, userId);
  const data = parseData(row?.data);
  const now = Date.now();
  if (now - (data.prunedAt ?? 0) < PRUNE_INTERVAL_MS) return;
  try {
    await pruneExpired(env.DB, userId, now - RETENTION_MS);
  } catch { /* 表正在被写 / 额度到了，都不该影响开站 */ }
  await putSettings(env.DB, userId, JSON.stringify({ ...data, prunedAt: now }), now).catch(() => {});
}

function parseData(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

// 一键清空：连消息带会话一起删，返回删掉的会话数
export async function handleClearConversations(env, userId) {
  return json({ ok: true, deleted: await deleteAllConversations(env.DB, userId) });
}

// 已经改成 rowid 游标翻页（?before=<最老一条的 id>）；limit 夹在 1–500，
// 负数在 SQLite 里等于「不限」，会让 slice 逻辑算错 hasMore
export async function handleConversationMessages(env, userId, id, url) {
  if (!(await getConversation(env.DB, userId, id))) return json({ error: '会话不存在' }, 404);
  const want = Number(url.searchParams.get('limit')) || 200;
  const limit = Math.min(Math.max(Math.trunc(want), 1), 500);
  const before = url.searchParams.get('before') || '';
  const { messages, hasMore } = await loadMessagesForDisplay(env.DB, id, limit, before || null);
  // images / meta 在库里是 JSON 文本，前端拿到结构化的更省事
  return json({ messages: messages.map((r) => ({ ...r, ...parseBoth(r) })), hasMore });
}

// 编辑重发、重新生成都靠它：把这条及其之后的消息抹掉
export async function handleRollback(request, env, userId, id) {
  const body = await request.json().catch(() => null);
  const fromMessageId = typeof body?.fromMessageId === 'string' ? body.fromMessageId : '';
  if (!fromMessageId) return json({ error: '缺少 fromMessageId' }, 400);
  if (!(await getConversation(env.DB, userId, id))) return json({ error: '会话不存在' }, 404);
  // DELETE 自带 conversation_id 条件，别人的消息 id 传进来只会删 0 行
  return json({ ok: true, deleted: await rollbackFrom(env.DB, id, fromMessageId) });
}

function parseBoth(row) {
  const out = {};
  try { out.images = row.images ? JSON.parse(row.images) : []; } catch { out.images = []; }
  try { out.meta = row.meta ? JSON.parse(row.meta) : null; } catch { out.meta = null; }
  return out;
}

export async function handleDeleteConversation(env, userId, id) {
  if (!(await getConversation(env.DB, userId, id))) return json({ error: '会话不存在' }, 404);
  await deleteConversation(env.DB, userId, id);
  return json({ ok: true });
}

export async function handleRenameConversation(request, env, userId, id) {
  const body = await request.json().catch(() => null);
  const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 60) : '';
  if (!title) return json({ error: '标题不能为空' }, 400);
  if (!(await getConversation(env.DB, userId, id))) return json({ error: '会话不存在' }, 404);
  await renameConversation(env.DB, userId, id, title);
  return json({ ok: true });
}
