// D1 访问层。所有查询都带 user_id 且命中索引（§3.3）；id 一律 bind，不拼 SQL。

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

// —— providers ————————————————————————————————

export async function listProviders(db, userId) {
  const { results } = await db
    .prepare('SELECT * FROM providers WHERE user_id = ? ORDER BY created_at')
    .bind(userId).all();
  return results ?? [];
}

export async function getProvider(db, userId, id) {
  const row = await db
    .prepare('SELECT * FROM providers WHERE user_id = ? AND id = ?')
    .bind(userId, id).first();
  return row;
}

export async function getEnabledProvider(db, userId) {
  const row = await db
    .prepare('SELECT * FROM providers WHERE user_id = ? AND is_enabled = 1 ORDER BY created_at LIMIT 1')
    .bind(userId).first();
  return row;
}

export async function insertProvider(db, p) {
  await db.prepare(`
    INSERT INTO providers
      (id, user_id, name, protocol, base_url, api_key, model, extra_headers,
       is_enabled, created_at, max_input_tokens, max_output_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    p.id, p.user_id, p.name, p.protocol, p.base_url, p.api_key, p.model,
    p.extra_headers, p.is_enabled, p.created_at, p.max_input_tokens, p.max_output_tokens,
  ).run();
}

export async function updateProvider(db, p) {
  await db.prepare(`
    UPDATE providers SET
      name = ?, protocol = ?, base_url = ?, api_key = ?, model = ?,
      extra_headers = ?, is_enabled = ?, max_input_tokens = ?, max_output_tokens = ?
    WHERE user_id = ? AND id = ?
  `).bind(
    p.name, p.protocol, p.base_url, p.api_key, p.model,
    p.extra_headers, p.is_enabled, p.max_input_tokens, p.max_output_tokens,
    p.user_id, p.id,
  ).run();
}

export async function deleteProvider(db, userId, id) {
  await db.prepare('DELETE FROM providers WHERE user_id = ? AND id = ?').bind(userId, id).run();
}

// D1 不强制外键（§4 注），置空引用必须自己发这条
export async function clearProviderRef(db, userId, id) {
  await db.prepare('UPDATE conversations SET provider_id = NULL WHERE user_id = ? AND provider_id = ?')
    .bind(userId, id).run();
}

export async function disableAll(db, userId) {
  await db.prepare('UPDATE providers SET is_enabled = 0 WHERE user_id = ?').bind(userId).run();
}

export async function enableOne(db, userId, id) {
  await db.prepare('UPDATE providers SET is_enabled = 1 WHERE user_id = ? AND id = ?').bind(userId, id).run();
}

// —— mcp_servers ——————————————————————————————

export async function listMcpServers(db, userId) {
  const { results } = await db
    .prepare('SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY created_at')
    .bind(userId).all();
  return results ?? [];
}

export async function getMcpServer(db, userId, id) {
  return db.prepare('SELECT * FROM mcp_servers WHERE user_id = ? AND id = ?').bind(userId, id).first();
}

export async function getEnabledMcpServers(db, userId) {
  // 不在 SQL 里 LIMIT：超出上限的服务会被 chat.js 点名提示，静默截断会让人以为配置没生效
  const { results } = await db
    .prepare('SELECT * FROM mcp_servers WHERE user_id = ? AND is_enabled = 1 ORDER BY created_at')
    .bind(userId).all();
  return results ?? [];
}

export async function insertMcpServer(db, s) {
  await db.prepare(`
    INSERT INTO mcp_servers (id, user_id, name, transport, url, headers, tool_filter, is_enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(s.id, s.user_id, s.name, s.transport, s.url, s.headers, s.tool_filter, s.is_enabled, s.created_at).run();
}

export async function updateMcpServer(db, s) {
  await db.prepare(`
    UPDATE mcp_servers SET name = ?, transport = ?, url = ?, headers = ?, tool_filter = ?, is_enabled = ?
    WHERE user_id = ? AND id = ?
  `).bind(s.name, s.transport, s.url, s.headers, s.tool_filter, s.is_enabled, s.user_id, s.id).run();
}

export async function deleteMcpServer(db, userId, id) {
  await db.prepare('DELETE FROM mcp_servers WHERE user_id = ? AND id = ?').bind(userId, id).run();
}

// —— conversations / messages ——————————————————

export async function listConversations(db, userId, limit = 50) {
  const { results } = await db.prepare(`
    SELECT id, title, provider_id, model, created_at, updated_at
    FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?
  `).bind(userId, limit).all();
  return results ?? [];
}

export async function getConversation(db, userId, id) {
  return db.prepare('SELECT * FROM conversations WHERE user_id = ? AND id = ?')
    .bind(userId, id).first();
}

export async function insertConversation(db, c) {
  await db.prepare(`
    INSERT INTO conversations (id, user_id, title, provider_id, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(c.id, c.user_id, c.title, c.provider_id, c.model, c.created_at, c.updated_at).run();
}

export async function touchConversation(db, userId, id, now) {
  await db.prepare('UPDATE conversations SET updated_at = ? WHERE user_id = ? AND id = ?')
    .bind(now, userId, id).run();
}

export async function renameConversation(db, userId, id, title) {
  await db.prepare('UPDATE conversations SET title = ? WHERE user_id = ? AND id = ?')
    .bind(title, userId, id).run();
}

export async function deleteConversation(db, userId, id) {
  // 两条都要发：先删子表再删父表，否则 messages 变孤儿
  await db.batch([
    db.prepare('DELETE FROM messages WHERE conversation_id = ? AND conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)').bind(id, userId),
    db.prepare('DELETE FROM conversations WHERE user_id = ? AND id = ?').bind(userId, id),
  ]);
}

export async function insertMessage(db, m) {
  await db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, tool_calls, tool_call_id, name, status, created_at, images, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    m.id, m.conversation_id, m.role, m.content, m.tool_calls,
    m.tool_call_id, m.name, m.status, m.created_at, m.images ?? null, m.meta ?? null,
  ).run();
}

export async function updateMessage(db, id, fields) {
  await db.prepare('UPDATE messages SET content = ?, status = ?, meta = ? WHERE id = ?')
    .bind(fields.content, fields.status, fields.meta ?? null, id).run();
}

// 组装上下文用：按插入顺序（rowid 比 created_at 可靠，同一毫秒会写入多条）取最近 limit 条。
// 故意不 select images / meta：历史图片几兆一条，每轮都读会把 D1 配额烧光。
export async function loadHistory(db, conversationId, limit) {
  const { results } = await db.prepare(`
    SELECT id, role, content, tool_calls, tool_call_id, name, status, created_at
    FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT ?
  `).bind(conversationId, limit).all();
  return (results ?? []).reverse();
}

// 展示用：把 images 和 meta 带上，前端还原缩略图与工具卡片
export async function loadMessagesForDisplay(db, conversationId, limit) {
  const { results } = await db.prepare(`
    SELECT id, role, content, images, meta, status, created_at
    FROM messages WHERE conversation_id = ? AND role IN ('user', 'assistant')
    ORDER BY rowid ASC LIMIT ?
  `).bind(conversationId, limit).all();
  return results ?? [];
}

// 本轮没带图、但更早的用户消息带过图：只取最近一组，让"这张图里是什么"能追问下去
export async function lastUserImages(db, conversationId) {
  const row = await db.prepare(`
    SELECT id, images FROM messages
    WHERE conversation_id = ? AND role = 'user' AND images IS NOT NULL
    ORDER BY rowid DESC LIMIT 1
  `).bind(conversationId).first();
  if (!row?.images) return null;
  try {
    const images = JSON.parse(row.images);
    return Array.isArray(images) && images.length ? { id: row.id, images } : null;
  } catch { return null; }
}

// 编辑重发 / 重新生成：删掉这条及其之后的所有消息。rowid 单调，比时间戳准
export async function rollbackFrom(db, conversationId, messageId) {
  const { meta } = await db.prepare(`
    DELETE FROM messages
    WHERE conversation_id = ? AND rowid >= (SELECT rowid FROM messages WHERE id = ? AND conversation_id = ?)
  `).bind(conversationId, messageId, conversationId).run();
  return meta?.changes ?? 0;
}

// 收藏按钮要按消息 id 单独取一条（含 meta），拿不到就说明不属于自己的会话
export async function getMessage(db, conversationId, messageId) {
  return db.prepare(`
    SELECT id, conversation_id, role, content, status, meta, created_at
    FROM messages WHERE conversation_id = ? AND id = ?
  `).bind(conversationId, messageId).first();
}

// 某条 assistant 消息之前最近的那条提问，给笔记当标题用。
// 位置靠 rowid 子查询定位，不 select rowid 本身，省得 D1 对隐式列较真
export async function prevUserMessage(db, conversationId, messageId) {
  const row = await db.prepare(`
    SELECT content FROM messages
    WHERE conversation_id = ? AND role = 'user'
      AND rowid < (SELECT rowid FROM messages WHERE id = ? AND conversation_id = ?)
    ORDER BY rowid DESC LIMIT 1
  `).bind(conversationId, messageId, conversationId).first();
  return row?.content ?? '';
}

// —— settings ——————————————————————————————————

export async function getSettings(db, userId) {
  return db.prepare('SELECT data FROM app_settings WHERE user_id = ?').bind(userId).first();
}

export async function putSettings(db, userId, data, now) {
  await db.prepare(`
    INSERT INTO app_settings (user_id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).bind(userId, data, now).run();
}

