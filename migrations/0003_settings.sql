-- 0003_settings.sql — 应用级设置（目前只有自定义名称），单人一行 JSON
-- 不建单独列：字段还会加（默认联网、默认朗读等），一行 JSON 免得反复 DDL

CREATE TABLE app_settings (
  user_id    TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
