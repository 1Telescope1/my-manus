-- 聚合根：保存路由、生命周期、恢复位置和乐观锁版本。
CREATE TABLE "agent_runs" (
  "id" VARCHAR(255) NOT NULL DEFAULT uuid_generate_v4()::text,
  "session_id" VARCHAR(255) NOT NULL,
  "route" VARCHAR(64) NOT NULL,
  "status" VARCHAR(64) NOT NULL DEFAULT 'created',
  "current_node" VARCHAR(512),
  "version" INTEGER NOT NULL DEFAULT 0,
  "cancel_requested_at" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "error" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- 可重试步骤：run_id、key、attempt 共同标识一次逻辑尝试。
CREATE TABLE "run_steps" (
  "id" VARCHAR(255) NOT NULL DEFAULT uuid_generate_v4()::text,
  "run_id" VARCHAR(255) NOT NULL,
  "key" VARCHAR(255) NOT NULL,
  "kind" VARCHAR(64) NOT NULL,
  "status" VARCHAR(64) NOT NULL DEFAULT 'pending',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "input" JSONB,
  "output" JSONB,
  "error" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "run_steps_pkey" PRIMARY KEY ("id")
);

-- 工具调用：持久化幂等身份、风险等级和可恢复执行结果。
CREATE TABLE "tool_call_records" (
  "id" VARCHAR(255) NOT NULL DEFAULT uuid_generate_v4()::text,
  "run_id" VARCHAR(255) NOT NULL,
  "step_id" VARCHAR(255) NOT NULL,
  "tool_name" VARCHAR(255) NOT NULL,
  "arguments" JSONB,
  "result" JSONB,
  "status" VARCHAR(64) NOT NULL DEFAULT 'pending',
  "risk" VARCHAR(64) NOT NULL,
  "idempotency_key" VARCHAR(512) NOT NULL,
  "request_fingerprint" VARCHAR(255) NOT NULL,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tool_call_records_pkey" PRIMARY KEY ("id")
);

-- 只追加检查点：sequence 和 next_event_sequence 共同维护恢复顺序。
CREATE TABLE "checkpoints" (
  "id" VARCHAR(255) NOT NULL DEFAULT uuid_generate_v4()::text,
  "run_id" VARCHAR(255) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "resume_node" VARCHAR(512) NOT NULL,
  "next_event_sequence" INTEGER NOT NULL,
  "state" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "checkpoints_pkey" PRIMARY KEY ("id")
);

-- 持久化等待用户输入或审批的中断。
CREATE TABLE "interruptions" (
  "id" VARCHAR(255) NOT NULL DEFAULT uuid_generate_v4()::text,
  "run_id" VARCHAR(255) NOT NULL,
  "kind" VARCHAR(64) NOT NULL,
  "status" VARCHAR(64) NOT NULL DEFAULT 'pending',
  "payload" JSONB NOT NULL DEFAULT '{}',
  "resolution" JSONB,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "interruptions_pkey" PRIMARY KEY ("id")
);

-- 查询索引和业务唯一约束由数据库负责解决并发竞争。
CREATE INDEX "agent_runs_session_id_created_at_idx" ON "agent_runs"("session_id", "created_at");
CREATE UNIQUE INDEX "run_steps_run_id_key_attempt_key" ON "run_steps"("run_id", "key", "attempt");
CREATE INDEX "run_steps_run_id_status_idx" ON "run_steps"("run_id", "status");
CREATE UNIQUE INDEX "tool_call_records_run_id_idempotency_key_key" ON "tool_call_records"("run_id", "idempotency_key");
CREATE INDEX "tool_call_records_run_id_status_idx" ON "tool_call_records"("run_id", "status");
CREATE INDEX "tool_call_records_step_id_idx" ON "tool_call_records"("step_id");
CREATE UNIQUE INDEX "checkpoints_run_id_sequence_key" ON "checkpoints"("run_id", "sequence");
CREATE INDEX "checkpoints_run_id_created_at_idx" ON "checkpoints"("run_id", "created_at");
CREATE INDEX "interruptions_run_id_status_idx" ON "interruptions"("run_id", "status");

-- 所有子记录随 Session/Run 删除，避免留下无法恢复的孤儿记录。
ALTER TABLE "agent_runs"
  ADD CONSTRAINT "agent_runs_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "run_steps"
  ADD CONSTRAINT "run_steps_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tool_call_records"
  ADD CONSTRAINT "tool_call_records_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tool_call_records"
  ADD CONSTRAINT "tool_call_records_step_id_fkey"
  FOREIGN KEY ("step_id") REFERENCES "run_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "checkpoints"
  ADD CONSTRAINT "checkpoints_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "interruptions"
  ADD CONSTRAINT "interruptions_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
