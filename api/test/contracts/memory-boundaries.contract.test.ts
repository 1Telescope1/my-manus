import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAgentRun,
  createCheckpoint,
  RouteKind,
} from '../../src/domain/models/agent-run';
import { ConversationMemory } from '../../src/domain/models/conversation-memory';
import { toWorkingContextMessages } from '../../src/domain/models/working-context';
import { DbConversationMemoryRepository } from '../../src/infrastructure/repositories/db-conversation-memory.repository';
import { DbSessionRepository } from '../../src/infrastructure/repositories/db-session.repository';

test('运行游标应由 Run State 保存且不进入 Conversation Memory', () => {
  const memory = new ConversationMemory([
    { role: 'user', content: '整理资料' },
    { role: 'assistant', content: '正在处理' },
  ]);
  const before = structuredClone(memory.getMessages());
  const run = createAgentRun({
    id: 'run-memory-boundary',
    sessionId: 'session-memory-boundary',
    route: RouteKind.WORKFLOW,
    currentNode: 'collect_sources',
  });
  const checkpoint = createCheckpoint({
    id: 'checkpoint-memory-boundary',
    runId: run.id,
    sequence: 0,
    resumeNode: 'summarize_sources',
    nextEventSequence: 3,
  });

  assert.equal(run.currentNode, 'collect_sources');
  assert.equal(checkpoint.resumeNode, 'summarize_sources');
  assert.deepEqual(memory.getMessages(), before);
  assert.doesNotMatch(JSON.stringify(memory.getMessages()), /currentNode|resumeNode/);
});

test('Working Context 应把受保护指令放入模型输入但不写回会话记忆', () => {
  const memory = new ConversationMemory([
    { role: 'system', content: 'BASE' },
    { role: 'user', content: '开始任务' },
  ]);
  const messages = toWorkingContextMessages({
    protectedInstructions: ['ACTIVE-SKILL'],
    conversationMessages: memory.getMessages(),
  });

  assert.deepEqual(messages.map((message) => message.content), [
    'BASE',
    'ACTIVE-SKILL',
    '开始任务',
  ]);
  assert.equal(memory.getMessages()[1].content, '开始任务');
  assert.doesNotMatch(JSON.stringify(memory.getMessages()), /ACTIVE-SKILL/);
});

test('Conversation Memory 仓储应兼容旧 JSON 并保持其他 Agent 记录', async () => {
  let memories: Record<string, unknown> = {
    planner: { messages: [{ role: 'system', content: '旧记录' }] },
  };
  const prisma = {
    session: {
      /** 返回旧版 Session.memories JSON。 */
      async findUnique() {
        return { memories };
      },
      /** 捕获仓储合并后的 Session.memories JSON。 */
      async update(input: { data: { memories: Record<string, unknown> } }) {
        memories = input.data.memories;
      },
    },
  };
  const repository = new DbConversationMemoryRepository(prisma as never);

  assert.equal((await repository.get('session-1', 'planner')).getMessages()[0].content, '旧记录');
  await repository.save(
    'session-1',
    'react',
    new ConversationMemory([{ role: 'user', content: '新记录' }]),
  );

  assert.deepEqual(memories, {
    planner: { messages: [{ role: 'system', content: '旧记录' }] },
    react: { messages: [{ role: 'user', content: '新记录' }] },
  });
  assert.equal('saveMemory' in DbSessionRepository.prototype, false);
  assert.equal('getMemory' in DbSessionRepository.prototype, false);
});
