-- 0002_message_images_meta.sql — 图片输入与工具卡片持久化（§4 增量）
-- D1 免费层 DDL 计入行读写，本文件只跑一次

-- images：JSON 数组，元素是 data URL（前端已压缩到长边 1280）。
-- 只在展示接口里读，组装上下文时不 select，避免每轮从 D1 拖几兆。
ALTER TABLE messages ADD COLUMN images TEXT;

-- meta：JSON，存思考文本摘要与工具调用卡片（名称/参数/状态/来源/截断预览），
-- 刷新页面后还能还原出工具过程。
ALTER TABLE messages ADD COLUMN meta TEXT;
