-- 工具显示名： tavily_search -> 联网搜索 这种映射，只影响界面
-- 发给模型的工具名永远是 MCP 里的原名，别名不做唯一性约束
ALTER TABLE mcp_servers ADD COLUMN tool_aliases TEXT;
