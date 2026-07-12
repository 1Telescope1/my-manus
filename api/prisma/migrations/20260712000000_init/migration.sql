CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE "sessions" (
  "id" VARCHAR(255) NOT NULL DEFAULT uuid_generate_v4()::text,
  "sandbox_id" VARCHAR(255),
  "task_id" VARCHAR(255),
  "title" VARCHAR(255) NOT NULL DEFAULT '',
  "unread_message_count" INTEGER NOT NULL DEFAULT 0,
  "latest_message" TEXT NOT NULL DEFAULT '',
  "latest_message_at" TIMESTAMP(3),
  "events" JSONB NOT NULL DEFAULT '[]',
  "files" JSONB NOT NULL DEFAULT '[]',
  "memories" JSONB NOT NULL DEFAULT '{}',
  "status" VARCHAR(255) NOT NULL DEFAULT '',
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "files" (
  "id" VARCHAR(255) NOT NULL DEFAULT uuid_generate_v4()::text,
  "filename" VARCHAR(255) NOT NULL DEFAULT '',
  "filepath" VARCHAR(255) NOT NULL DEFAULT '',
  "key" VARCHAR(255) NOT NULL DEFAULT '',
  "extension" VARCHAR(255) NOT NULL DEFAULT '',
  "mime_type" VARCHAR(255) NOT NULL DEFAULT '',
  "size" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);
