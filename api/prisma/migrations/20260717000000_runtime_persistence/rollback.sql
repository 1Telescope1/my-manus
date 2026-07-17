-- 必须先删除引用 AgentRun 的子表，再删除步骤和聚合根。
DROP TABLE IF EXISTS "interruptions";
DROP TABLE IF EXISTS "checkpoints";
DROP TABLE IF EXISTS "tool_call_records";
DROP TABLE IF EXISTS "run_steps";
DROP TABLE IF EXISTS "agent_runs";
