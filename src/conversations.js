import { json } from './util.js';
import {
  listConversations, getConversation, deleteConversation,
  renameConversation, loadMessagesForDisplay, rollbackFrom,
} from './db.js';

export async function handleListConversations(env, userId) {
  return json({ conversations: await listConversations(env.DB, userId) });
}

// 分页先按"取最近 N 条"做，M2 再换游标（§3.3 第 2 条）
export async function handleConversationMessages(env, userId, id, url) {
  if (!(await getConversation(env.DB, userId, id))) return json({ error: '会话不存在' }, 404);
  const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500);
  const rows = await loadMessagesForDisplay(env.DB, id, limit);
  // images / meta 在库里是 JSON 文本，前端拿到结构化的更省事
  return json({ messages: rows.map((r) => ({ ...r, ...parseBoth(r) })) });
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
