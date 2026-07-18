import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolApprovalGate } from '../../src/domain/models/tool-invocation';
import {
  ToolExecutionContext,
  ToolRegistration,
  ToolRisk,
} from '../../src/domain/models/tool';
import { ToolResult } from '../../src/domain/models/tool-result';
import {
  InMemoryToolIdempotencyStore,
  ToolInvocationService,
} from '../../src/domain/services/tools/tool-invocation.service';
import { InMemoryToolRegistry } from '../../src/domain/services/tools/tool-registry';

type RegistrationOverrides = {
  risk?: ToolRisk;
  requiresApproval?: boolean;
  timeoutMs?: number;
  supportsAbortSignal?: boolean;
  supportsIdempotency?: boolean;
};

/** 创建可精确控制执行行为的测试工具注册项。 */
function registration(
  invoke: (
    arguments_: Record<string, unknown>,
    context?: ToolExecutionContext,
  ) => Promise<ToolResult>,
  overrides: RegistrationOverrides = {},
): ToolRegistration {
  return {
    descriptor: {
      id: 'builtin:test_tool',
      name: 'test_tool',
      source: 'builtin',
      description: '测试可靠调用',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      capabilities: ['test'],
      risk: overrides.risk ?? 'read',
      requiresApproval: overrides.requiresApproval ?? false,
      timeoutMs: overrides.timeoutMs ?? 100,
    },
    groupName: 'test',
    invoke,
    supportsAbortSignal: overrides.supportsAbortSignal,
    supportsIdempotency: overrides.supportsIdempotency,
  };
}

/** 用单个注册项创建可靠调用服务。 */
function createService(
  item: ToolRegistration,
  options: ConstructorParameters<typeof ToolInvocationService>[1] = {},
): ToolInvocationService {
  const registry = new InMemoryToolRegistry();
  registry.register(item);
  return new ToolInvocationService(registry, options);
}

/** 创建所有测试共用的最小调用输入。 */
function request(overrides: Partial<{
  arguments: Record<string, unknown>;
  scopeId: string;
  idempotencyKey: string;
  signal: AbortSignal;
}> = {}) {
  return {
    functionName: 'test_tool',
    arguments: { value: 'ok' },
    scopeId: 'run-1',
    ...overrides,
  };
}

test('可靠调用应返回统一成功结果并传递执行上下文', async () => {
  let receivedContext: ToolExecutionContext | undefined;
  const service = createService(registration(async (arguments_, context) => {
    receivedContext = context;
    return { success: true, data: arguments_ };
  }, { supportsAbortSignal: true }));

  const result = await service.invoke(request({ idempotencyKey: 'call-1' }));

  assert.equal(result.success, true);
  assert.deepEqual(result.data, { value: 'ok' });
  assert.equal(result.error, undefined);
  assert.equal(result.metadata?.attempts, 1);
  assert.equal(result.metadata?.risk, 'read');
  assert.equal(result.metadata?.idempotencyKey, 'call-1');
  assert.equal(result.metadata?.signalPropagation, 'forwarded');
  assert.equal(receivedContext?.attempt, 1);
  assert.equal(receivedContext?.idempotencyKey, 'call-1');
  assert.equal(receivedContext?.signal.aborted, false);
});

test('输入不符合 Schema 时不应执行工具', async () => {
  let calls = 0;
  const service = createService(registration(async () => {
    calls += 1;
    return { success: true };
  }));

  const missing = await service.invoke(request({ arguments: {} }));
  const wrongType = await service.invoke(request({ arguments: { value: 42 } }));

  assert.equal(calls, 0);
  assert.equal(missing.error?.code, 'invalid_input');
  assert.deepEqual(missing.error?.details, ['value 为必填字段']);
  assert.equal(wrongType.error?.code, 'invalid_input');
  assert.deepEqual(wrongType.error?.details, ['value 必须是 string']);
});

test('需要审批的工具在审批器缺失或拒绝时不应执行', async () => {
  let calls = 0;
  const item = registration(async () => {
    calls += 1;
    return { success: true };
  }, { risk: 'destructive', requiresApproval: true });
  const missingGate = createService(item);
  const deniedGate: ToolApprovalGate = {
    /** 固定拒绝本次测试调用。 */
    async authorize() {
      return { outcome: 'denied', reason: '用户拒绝删除' };
    },
  };
  const denied = createService(item, { approvalGate: deniedGate });

  const requiredResult = await missingGate.invoke(request());
  const deniedResult = await denied.invoke(request());

  assert.equal(calls, 0);
  assert.equal(requiredResult.error?.code, 'approval_required');
  assert.equal(deniedResult.error?.code, 'approval_denied');
  assert.equal(deniedResult.message, '用户拒绝删除');
});

test('审批通过后应只审批一次并执行工具', async () => {
  let approvals = 0;
  let calls = 0;
  const gate: ToolApprovalGate = {
    /** 记录审批次数并固定批准。 */
    async authorize() {
      approvals += 1;
      return { outcome: 'approved' };
    },
  };
  const service = createService(registration(async () => {
    calls += 1;
    return { success: true, data: 'deleted' };
  }, { risk: 'destructive', requiresApproval: true }), { approvalGate: gate });

  const result = await service.invoke(request());

  assert.equal(result.success, true);
  assert.equal(approvals, 1);
  assert.equal(calls, 1);
});

test('只读工具的瞬时异常应最多自动重试两次', async () => {
  let calls = 0;
  const service = createService(registration(async () => {
    calls += 1;
    if (calls < 3) {
      throw new Error('临时不可用');
    }
    return { success: true, data: 'recovered' };
  }));

  const result = await service.invoke(request());

  assert.equal(result.success, true);
  assert.equal(result.data, 'recovered');
  assert.equal(result.metadata?.attempts, 3);
  assert.equal(calls, 3);
});

test('副作用工具没有适配器幂等保证时不应自动重试', async () => {
  let calls = 0;
  const service = createService(registration(async () => {
    calls += 1;
    throw new Error('写入响应丢失');
  }, { risk: 'write' }));

  const result = await service.invoke(request({ idempotencyKey: 'write-1' }));

  assert.equal(calls, 1);
  assert.equal(result.error?.code, 'execution_failed');
  assert.equal(result.error?.retryable, true);
  assert.equal(result.metadata?.attempts, 1);
});

test('副作用工具只有声明适配器幂等支持后才可安全重试', async () => {
  let calls = 0;
  const service = createService(registration(async (_arguments, context) => {
    calls += 1;
    assert.equal(context?.idempotencyKey, 'write-2');
    if (calls === 1) {
      throw new Error('瞬时网络错误');
    }
    return { success: true, data: 'written' };
  }, { risk: 'write', supportsIdempotency: true }));

  const result = await service.invoke(request({ idempotencyKey: 'write-2' }));

  assert.equal(result.success, true);
  assert.equal(calls, 2);
  assert.equal(result.metadata?.attempts, 2);
});

test('工具超时后应中止 Signal 并停止消费迟到结果', async () => {
  let receivedSignal: AbortSignal | undefined;
  const service = createService(registration(async (_arguments, context) => {
    receivedSignal = context?.signal;
    return new Promise<ToolResult>(() => undefined);
  }, { risk: 'write', timeoutMs: 10, supportsAbortSignal: true }));

  const result = await service.invoke(request());

  assert.equal(result.error?.code, 'timeout');
  assert.equal(result.metadata?.attempts, 1);
  assert.equal(receivedSignal?.aborted, true);
});

test('外部取消应优先返回 cancelled 且不得重试', async () => {
  let calls = 0;
  const controller = new AbortController();
  const service = createService(registration(async () => {
    calls += 1;
    return new Promise<ToolResult>(() => undefined);
  }, { timeoutMs: 1_000 }));

  const pending = service.invoke(request({ signal: controller.signal }));
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort('用户取消');
  const result = await pending;

  assert.equal(calls, 1);
  assert.equal(result.error?.code, 'cancelled');
  assert.equal(result.error?.retryable, false);
  assert.equal(result.metadata?.attempts, 1);
});

test('相同幂等请求应复用结果而不同请求应报告冲突', async () => {
  let calls = 0;
  const store = new InMemoryToolIdempotencyStore();
  const service = createService(registration(async (arguments_) => {
    calls += 1;
    return { success: true, data: arguments_ };
  }, { risk: 'write' }), { idempotencyStore: store });

  const first = await service.invoke(request({ idempotencyKey: 'stable-key' }));
  const replayed = await service.invoke(request({ idempotencyKey: 'stable-key' }));
  const conflict = await service.invoke(request({
    idempotencyKey: 'stable-key',
    arguments: { value: 'different' },
  }));

  assert.equal(first.success, true);
  assert.equal(replayed.success, true);
  assert.equal(replayed.metadata?.replayed, true);
  assert.equal(replayed.metadata?.attempts, 0);
  assert.equal(conflict.error?.code, 'idempotency_conflict');
  assert.equal(calls, 1);
});

test('同一幂等调用并发执行时只应放行一个实际调用', async () => {
  let calls = 0;
  let resolveFirst: ((result: ToolResult) => void) | undefined;
  const service = createService(registration(async () => {
    calls += 1;
    return new Promise<ToolResult>((resolve) => {
      resolveFirst = resolve;
    });
  }, { risk: 'write' }));

  const first = service.invoke(request({ idempotencyKey: 'concurrent' }));
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await service.invoke(request({ idempotencyKey: 'concurrent' }));
  resolveFirst?.({ success: true, data: 'done' });
  const completed = await first;

  assert.equal(calls, 1);
  assert.equal(duplicate.error?.code, 'duplicate_in_progress');
  assert.equal(completed.success, true);
});

test('工具返回失败状态时应补齐结构化错误而不是包装为成功', async () => {
  const service = createService(registration(async () => ({
    success: false,
    message: '业务执行失败',
  })));

  const result = await service.invoke(request());

  assert.equal(result.success, false);
  assert.equal(result.error?.code, 'execution_failed');
  assert.equal(result.error?.message, '业务执行失败');
  assert.equal(result.error?.retryable, false);
});
