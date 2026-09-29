-- 0001_provider_token_limits.sql
-- 学校v100 这类自托管端点的上下文窗口是配置的一部分（262144 / 16384），
-- 存库里而不是写死在代码里，换模型不用改代码。
ALTER TABLE providers ADD COLUMN max_input_tokens INTEGER;
ALTER TABLE providers ADD COLUMN max_output_tokens INTEGER;
