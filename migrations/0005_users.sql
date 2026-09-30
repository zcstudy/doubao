-- 0005_users.sql — 多用户：手机号即账号，注册/登录都要过访问口令
-- 密码按用户要求明文存（能在 D1 里直接看到、直接改）；代价是这份库一旦外泄，
-- 等于所有账号口令一起外泄，导出的查询语句不要贴到公开地方

CREATE TABLE users (
  phone      TEXT PRIMARY KEY,
  password   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
