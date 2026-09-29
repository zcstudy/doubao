-- 0000_init_schema.sql — 建表语句来自 Cloudflare部署方案.md §4
-- 注意：D1 免费层自 2026-09-01 起硬性限额，DDL 也计入行读写，本文件只跑一次

CREATE TABLE providers (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  protocol      TEXT NOT NULL DEFAULT 'openai-compatible',
  base_url      TEXT NOT NULL,
  api_key       TEXT NOT NULL,
  model         TEXT NOT NULL,
  extra_headers TEXT,
  is_enabled    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_provider_user ON providers(user_id, is_enabled);

CREATE TABLE mcp_servers (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  transport   TEXT NOT NULL,
  url         TEXT NOT NULL,
  headers     TEXT,
  tool_filter TEXT,
  is_enabled  INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_mcp_user ON mcp_servers(user_id, is_enabled);

CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  provider_id TEXT,
  model       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_conv_user_updated ON conversations(user_id, updated_at DESC);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT,
  tool_calls      TEXT,
  tool_call_id    TEXT,
  name            TEXT,
  status          TEXT NOT NULL DEFAULT 'done',
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_msg_conv_created ON messages(conversation_id, created_at);

-- M0 用来验证 Pages ↔ D1 读写打通，后续里程碑不再使用
CREATE TABLE ping_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ping_user ON ping_log(user_id, created_at);
