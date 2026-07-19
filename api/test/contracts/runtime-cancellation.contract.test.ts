import assert from 'node:assert/strict';
import test from 'node:test';
import { Browser } from '../../src/domain/external/browser';
import { LLM, LLMMessage } from '../../src/domain/external/llm';
import { RuntimeRouteModel } from '../../src/domain/external/runtime-route-model';
import { Sandbox } from '../../src/domain/external/sandbox';
import {
  AgentRun,
  Checkpoint,
  RouteKind,
  RunStatus,
  canTransitionRunStatus,
  createAgentRun,
} from '../../src/domain/models/agent-run';
import { MCPTransport } from '../../src/domain/models/app-config';
import { createMessage } from '../../src/domain/models/message';
import { RuntimeEvent } from '../../src/domain/models/runtime-event';
import {
  AgentRunRepository,
  CheckpointAppendResult,
} from '../../src/domain/repositories/agent-run.repository';
import { UnitOfWork } from '../../src/domain/repositories/unit-of-work';
import { LLMDirectResponseProvider } from '../../src/domain/services/runtime/adapters';
import {
  DirectRuntimeExecutor,
  PlannedAgentRuntimeExecutor,
  RuntimeExecutorDispatcher,
  SingleToolRuntimeExecutor,
  WorkflowRuntimeExecutor,
} from '../../src/domain/services/runtime/executor.service';
import { RuntimeRouterService } from '../../src/domain/services/runtime/router.service';
import { RuntimeService } from '../../src/domain/services/runtime/runtime.service';
import { isCancellationError } from '../../src/domain/services/runtime/cancellation';
import { BrowserTool } from '../../src/domain/services/tools/browser.tool';
import {
  MCPClientManager,
  MCPServerConnector,
} from '../../src/domain/services/tools/mcp.tool';
import { ShellTool } from '../../src/domain/services/tools/shell.tool';
import { ToolInvocationService } from '../../src/domain/services/tools/tool-invocation.service';
import { InMemoryToolRegistry } from '../../src/domain/services/tools/tool-registry';
import { A2AClientManager } from '../../src/domain/services/tools/a2a.tool';
import { OpenAILLM } from '../../src/infrastructure/external/llm/openai-llm';

/** 创建可由测试显式完成或拒绝的 Promise。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** 使用单个 BaseTool 注册项创建可靠调用服务。 */
function invocationService(tool: ShellTool | BrowserTool): ToolInvocationService {
  const registry = new InMemoryToolRegistry();
  registry.registerAll(tool.getRegistrations());
  return new ToolInvocationService(registry);
}

/** 消费 Runtime Event 流并保留完整顺序。 */
async function collect(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const result: RuntimeEvent[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

test('SDK 包装取消异常后应以根 Signal 的终止状态为准', () => {
  const controller = new AbortController();
  controller.abort(new DOMException('用户取消任务', 'AbortError'));

  const wrapped = new Error('MCP error -32001: AbortError: 用户取消任务');
  assert.equal(wrapped.name, 'Error');
  assert.equal(isCancellationError(wrapped), false);
  assert.equal(isCancellationError(wrapped, controller.signal), true);
});

class AbortableLLM extends LLM {
  readonly modelName = 'abortable';
  readonly temperature = 0;
  readonly maxTokens = 128;
  readonly started = deferred<void>();
  receivedSignal?: AbortSignal;

  /** 保存模型 Signal，并保持请求进行中直到 Signal 取消。 */
  async invoke(input: Parameters<LLM['invoke']>[0]): Promise<LLMMessage> {
    this.receivedSignal = input.signal;
    this.started.resolve();
    return new Promise((_resolve, reject) => {
      input.signal?.addEventListener('abort', () => reject(
        input.signal?.reason ?? new DOMException('模型调用已取消', 'AbortError'),
      ), { once: true });
    });
  }
}

test('LLM 取消应产生 run.cancelled 且不输出迟到消息', async () => {
  const llm = new AbortableLLM();
  const controller = new AbortController();
  const executor = new DirectRuntimeExecutor(new LLMDirectResponseProvider(llm));
  const running = { ...createAgentRun({
    id: 'run-llm-cancel',
    sessionId: 'session-1',
    route: RouteKind.DIRECT,
  }), status: RunStatus.RUNNING };

  const pending = collect(executor.execute({
    run: running,
    decision: {
      route: RouteKind.DIRECT,
      reason: '测试取消',
      requiredCapabilities: [],
      requestedSkills: [],
      confidence: 1,
    },
    message: '什么是取消？',
    signal: controller.signal,
  }));
  await llm.started.promise;
  controller.abort(new DOMException('用户取消', 'AbortError'));

  const events = await pending;
  assert.equal(llm.receivedSignal, controller.signal);
  assert.deepEqual(events.map((event) => event.type), ['run.cancelled']);
});

test('OpenAI 适配器应使用请求 Signal 中止厂商 HTTP 调用', async () => {
  const started = deferred<void>();
  let receivedSignal: AbortSignal | null | undefined;
  const llm = new OpenAILLM({
    base_url: 'https://llm.example.test',
    api_key: 'test-key',
    model_name: 'test-model',
    temperature: 0,
    max_tokens: 128,
  }, {
    /** 模拟进行中的厂商 HTTP 请求，并观察 SDK 传入的 Signal。 */
    fetch: async (_input, init) => {
      receivedSignal = init?.signal;
      started.resolve();
      return new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    },
  });
  const controller = new AbortController();
  const pending = llm.invoke({
    messages: [{ role: 'user', content: '测试取消' }],
    signal: controller.signal,
  });

  await started.promise;
  controller.abort(new DOMException('用户取消', 'AbortError'));

  await assert.rejects(pending);
  assert.equal(receivedSignal?.aborted, true);
});

test('Shell 取消应把 Signal 传到底层并停止消费命令结果', async () => {
  let receivedSignal: AbortSignal | undefined;
  const sandbox = {
    /** 模拟持续读取的 Shell 请求，并在根 Signal 取消时拒绝。 */
    readShellOutput: async (_sessionId: string, _console: boolean, signal?: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  } as unknown as Sandbox;
  const service = invocationService(new ShellTool(sandbox));
  const controller = new AbortController();

  const pending = service.invoke({
    functionName: 'shell_read_output',
    arguments: { session_id: 'shell-1' },
    scopeId: 'run-shell',
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort('用户取消');

  const result = await pending;
  assert.equal(receivedSignal?.aborted, true);
  assert.equal(result.error?.code, 'cancelled');
  assert.equal(result.metadata?.signalPropagation, 'forwarded');
});

test('Browser 取消应把 Signal 传到底层并停止消费页面结果', async () => {
  let receivedSignal: AbortSignal | undefined;
  const browser = {
    /** 模拟持续读取页面，并在根 Signal 取消时拒绝。 */
    viewPage: async (signal?: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  } as unknown as Browser;
  const service = invocationService(new BrowserTool(browser));
  const controller = new AbortController();

  const pending = service.invoke({
    functionName: 'browser_view',
    arguments: {},
    scopeId: 'run-browser',
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort('用户取消');

  const result = await pending;
  assert.equal(receivedSignal?.aborted, true);
  assert.equal(result.error?.code, 'cancelled');
  assert.equal(result.metadata?.signalPropagation, 'forwarded');
});

test('MCP 取消应把 Signal 交给 SDK callTool', async () => {
  let receivedSignal: AbortSignal | undefined;
  const connector: MCPServerConnector = async () => ({
    client: {
      /** 返回一个可调用的远程工具。 */
      async listTools() {
        return { tools: [{ name: 'lookup' }] };
      },
      /** 保持 MCP 请求进行中，直到 SDK options.signal 取消。 */
      async callTool(_input, _schema, options) {
        receivedSignal = options?.signal;
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        });
      },
    },
  });
  const manager = new MCPClientManager({
    mcpServers: {
      crm: {
        enabled: true,
        transport: MCPTransport.STREAMABLE_HTTP,
        url: 'https://mcp.example.test',
      },
    },
  }, { connector });
  await manager.initialize();
  const controller = new AbortController();

  const pending = manager.invoke('mcp_crm_lookup', {}, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort('用户取消');

  await assert.rejects(pending);
  assert.equal(receivedSignal, controller.signal);
});

test('A2A 取消应中止远程 fetch', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  let receivedSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (_input, init) => {
    callCount += 1;
    if (callCount === 1) {
      return new Response(JSON.stringify({ url: 'https://agent.example.test/rpc' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    receivedSignal = init?.signal;
    return new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  };

  try {
    const manager = new A2AClientManager({
      a2a_servers: [{
        id: 'researcher',
        base_url: 'https://agent.example.test',
        enabled: true,
      }],
    });
    await manager.initialize();
    const controller = new AbortController();
    const pending = manager.invoke('researcher', '研究取消语义', controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort('用户取消');

    await assert.rejects(pending);
    assert.equal(receivedSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

class CancellationStore {
  readonly runs = new Map<string, AgentRun>();
  readonly checkpoints: Checkpoint[] = [];

  /** 创建 Runtime 和 Checkpoint 共用的内存事务边界。 */
  createUnitOfWork(): UnitOfWork {
    const repository = this.repository();
    const unit = {
      agentRun: repository,
      session: { updateStatus: async () => undefined },
      run: async <T>(handler: (active: UnitOfWork) => Promise<T>) =>
        handler(unit as unknown as UnitOfWork),
    } as unknown as UnitOfWork;
    return unit;
  }

  /** 创建支持 Run CAS 和 Checkpoint 追加的最小仓储。 */
  private repository(): AgentRunRepository {
    return {
      create: async (run: AgentRun) => { this.runs.set(run.id, run); },
      getById: async (runId: string) => this.runs.get(runId) ?? null,
      update: async (candidate: AgentRun, expectedVersion: number) => {
        const current = this.runs.get(candidate.id);
        if (!current) return { outcome: 'not_found' as const };
        if (current.version !== expectedVersion || candidate.version !== expectedVersion) {
          return { outcome: 'version_conflict' as const, actualVersion: current.version };
        }
        if (current.status !== candidate.status
          && !canTransitionRunStatus(current.status, candidate.status)) {
          return {
            outcome: 'invalid_status_transition' as const,
            from: current.status,
            to: candidate.status,
          };
        }
        const updated = { ...candidate, version: expectedVersion + 1 };
        this.runs.set(updated.id, updated);
        return { outcome: 'updated' as const, run: updated };
      },
      getLatestCheckpoint: async (runId: string) => this.checkpoints
        .filter((checkpoint) => checkpoint.runId === runId)
        .at(-1) ?? null,
      appendCheckpoint: async (checkpoint: Checkpoint): Promise<CheckpointAppendResult> => {
        this.checkpoints.push(checkpoint);
        return { outcome: 'appended', checkpoint };
      },
    } as unknown as AgentRunRepository;
  }
}

test('根取消应先记录请求再收敛到 CANCELLED，且不调度后续事件', async () => {
  const store = new CancellationStore();
  const llm = new AbortableLLM();
  const direct = new DirectRuntimeExecutor(new LLMDirectResponseProvider(llm));
  const unavailable = {
    /** 本测试只走 Direct，其他路径若被调度即失败。 */
    async *execute(): AsyncIterable<never> {
      throw new Error('取消测试不应调度其他路径');
    },
  };
  const dispatcher = new RuntimeExecutorDispatcher([
    direct,
    new SingleToolRuntimeExecutor(
      { select: async () => { throw new Error('不应选择工具'); } },
      { invoke: async () => { throw new Error('不应调用工具'); } },
      { respond: async () => { throw new Error('不应总结工具'); } },
    ),
    new WorkflowRuntimeExecutor(unavailable),
    new PlannedAgentRuntimeExecutor(unavailable),
  ]);
  const routeModel = new class extends RuntimeRouteModel {
    /** 确定性规则命中时模型不应被调用。 */
    async decide(): Promise<unknown> {
      throw new Error('不应调用路由模型');
    }
  }();
  const router = new RuntimeRouterService(routeModel, {
    rules: [{
      name: 'always-direct',
      /** 固定选择 Direct，隔离本测试与路由模型。 */
      evaluate: () => ({
        route: RouteKind.DIRECT,
        reason: '取消持久化测试',
        requiredCapabilities: [],
        requestedSkills: [],
        confidence: 1,
      }),
    }],
  });
  const runtime = new RuntimeService(() => store.createUnitOfWork(), router, dispatcher);
  const controller = new AbortController();
  const pending = collect(runtime.execute({
    sessionId: 'session-cancel',
    message: createMessage({ message: '什么是 Runtime？' }),
    signal: controller.signal,
  }));

  await llm.started.promise;
  await runtime.requestCancellation();
  const requested = [...store.runs.values()][0];
  assert.ok(requested.cancelRequestedAt instanceof Date);
  controller.abort(new DOMException('用户取消', 'AbortError'));

  const events = await pending;
  const completed = [...store.runs.values()][0];
  assert.deepEqual(events.map((event) => event.type), ['run.cancelled']);
  assert.equal(completed.status, RunStatus.CANCELLED);
  assert.deepEqual(completed.metadata.cancellation, { outcome: 'confirmed' });
});
