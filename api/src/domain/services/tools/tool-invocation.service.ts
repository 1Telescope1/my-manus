import { createHash } from 'node:crypto';
import {
  ToolApprovalGate,
  ToolIdempotencyReservation,
  ToolIdempotencyExecutionInput,
  ToolIdempotencyReservationInput,
  ToolIdempotencyStore,
  ToolInvocationRequest,
} from '../../models/tool-invocation';
import { ToolRegistration, ToolRegistry } from '../../models/tool';
import {
  ToolErrorCode,
  ToolResult,
  ToolResultMetadata,
} from '../../models/tool-result';

const DEFAULT_MAX_READ_ATTEMPTS = 3;

export type ToolInvocationServiceOptions = {
  approvalGate?: ToolApprovalGate;
  idempotencyStore?: ToolIdempotencyStore;
  maxReadAttempts?: number;
  clock?: () => number;
};

type StoredInvocation = {
  requestFingerprint: string;
  result?: ToolResult;
};

type AttemptOutcome =
  | { kind: 'result'; result: ToolResult }
  | { kind: 'timeout'; message: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'error'; message: string };

/** 为测试和单进程运行提供原子幂等占用；持久化恢复由 RUNTIME-107 接管。 */
export class InMemoryToolIdempotencyStore implements ToolIdempotencyStore {
  private readonly entries = new Map<string, StoredInvocation>();

  /** 按 scope 和 key 原子判断首次调用、重放、执行中或指纹冲突。 */
  async reserve(input: ToolIdempotencyReservationInput): Promise<ToolIdempotencyReservation> {
    const key = storageKey(input.scopeId, input.idempotencyKey);
    const existing = this.entries.get(key);
    if (!existing) {
      this.entries.set(key, { requestFingerprint: input.requestFingerprint });
      return { outcome: 'reserved' };
    }
    if (existing.requestFingerprint !== input.requestFingerprint) {
      return { outcome: 'conflict' };
    }
    return existing.result
      ? { outcome: 'existing', result: structuredClone(existing.result) }
      : { outcome: 'in_progress' };
  }

  /** 进程内占用在 reserve 时已完成，开始钩子保持空操作。 */
  async start(_input: ToolIdempotencyExecutionInput): Promise<void> {}

  /** 仅完成同一指纹已占用的调用，防止错误覆盖其他请求。 */
  async complete(input: ToolIdempotencyExecutionInput & {
    result: ToolResult;
  }): Promise<void> {
    const key = storageKey(input.scopeId, input.idempotencyKey);
    const existing = this.entries.get(key);
    if (!existing || existing.requestFingerprint !== input.requestFingerprint) {
      throw new Error('幂等调用未占用或请求指纹不一致');
    }
    existing.result = structuredClone(input.result);
  }
}

/** 在 Tool Registry 之上统一执行校验、审批、幂等、取消、超时和风险感知重试。 */
export class ToolInvocationService {
  private readonly idempotencyStore: ToolIdempotencyStore;
  private readonly maxReadAttempts: number;
  private readonly clock: () => number;

  /** 注入 Registry 与可替换策略端口；审批器缺失时需要审批的工具默认拒绝。 */
  constructor(
    private readonly registry: ToolRegistry,
    private readonly options: ToolInvocationServiceOptions = {},
  ) {
    this.idempotencyStore = options.idempotencyStore ?? new InMemoryToolIdempotencyStore();
    this.maxReadAttempts = options.maxReadAttempts ?? DEFAULT_MAX_READ_ATTEMPTS;
    this.clock = options.clock ?? Date.now;
    if (!Number.isSafeInteger(this.maxReadAttempts) || this.maxReadAttempts < 1) {
      throw new Error('maxReadAttempts 必须是正安全整数');
    }
  }

  /** 按固定安全顺序执行一次注册工具，并把所有失败归一为 ToolResult。 */
  async invoke(request: ToolInvocationRequest): Promise<ToolResult> {
    const startedAt = this.clock();
    const registration = this.registry.resolve(request.functionName);
    if (!registration) {
      return this.failure(
        'execution_failed',
        `工具不存在：${request.functionName}`,
        false,
        undefined,
        startedAt,
        0,
      );
    }

    const validationErrors = validateToolArguments(
      request.arguments,
      registration.descriptor.inputSchema,
    );
    if (validationErrors.length > 0) {
      return this.failure(
        'invalid_input',
        '工具输入不符合 Schema',
        false,
        registration,
        startedAt,
        0,
        validationErrors,
        request.idempotencyKey,
      );
    }

    const approvalFailure = await this.checkApproval(registration, request, startedAt);
    if (approvalFailure) {
      return approvalFailure;
    }

    const requestFingerprint = fingerprint(request.functionName, request.arguments);
    const reservation = await this.reserve(registration, request, requestFingerprint);
    const reservationResult = this.resultFromReservation(
      reservation,
      registration,
      request,
      startedAt,
    );
    if (reservationResult) {
      return reservationResult;
    }

    if (request.idempotencyKey) {
      await this.idempotencyStore.start({
        scopeId: request.scopeId,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint,
      });
    }

    const maxAttempts = this.maxAttempts(registration, request);
    let finalResult: ToolResult | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const outcome = await this.executeAttempt(registration, request, attempt);
      finalResult = this.resultFromAttempt(
        outcome,
        registration,
        request,
        startedAt,
        attempt,
      );
      if (finalResult.success || !finalResult.error?.retryable || attempt === maxAttempts) {
        break;
      }
    }

    const result = finalResult as ToolResult;
    if (request.idempotencyKey) {
      await this.idempotencyStore.complete({
        scopeId: request.scopeId,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint,
        result,
        risk: registration.descriptor.risk,
      });
    }
    return result;
  }

  /** 对声明需要审批的工具执行 fail-closed 审批检查。 */
  private async checkApproval(
    registration: ToolRegistration,
    request: ToolInvocationRequest,
    startedAt: number,
  ): Promise<ToolResult | undefined> {
    if (!registration.descriptor.requiresApproval) {
      return undefined;
    }
    if (!this.options.approvalGate) {
      return this.failure(
        'approval_required',
        `工具需要审批：${registration.descriptor.name}`,
        false,
        registration,
        startedAt,
        0,
        undefined,
        request.idempotencyKey,
      );
    }
    const decision = await this.options.approvalGate.authorize({
      descriptor: registration.descriptor,
      arguments: request.arguments,
      scopeId: request.scopeId,
      idempotencyKey: request.idempotencyKey,
      signal: request.signal,
    });
    return decision.outcome === 'approved'
      ? undefined
      : this.failure(
        'approval_denied',
        decision.reason ?? `工具审批被拒绝：${registration.descriptor.name}`,
        false,
        registration,
        startedAt,
        0,
        undefined,
        request.idempotencyKey,
      );
  }

  /** 仅在调用方提供幂等键时占用；未提供时返回首次执行语义。 */
  private async reserve(
    registration: ToolRegistration,
    request: ToolInvocationRequest,
    requestFingerprint: string,
  ): Promise<ToolIdempotencyReservation> {
    if (!request.idempotencyKey) {
      return { outcome: 'reserved' };
    }
    return this.idempotencyStore.reserve({
      scopeId: request.scopeId,
      idempotencyKey: request.idempotencyKey,
      requestFingerprint,
      toolCallId: request.toolCallId,
      stepId: request.stepId,
      functionName: request.functionName,
      arguments: request.arguments,
      risk: registration.descriptor.risk,
    });
  }

  /** 把幂等重放、冲突和执行中状态转换为稳定结果。 */
  private resultFromReservation(
    reservation: ToolIdempotencyReservation,
    registration: ToolRegistration,
    request: ToolInvocationRequest,
    startedAt: number,
  ): ToolResult | undefined {
    if (reservation.outcome === 'reserved') {
      return undefined;
    }
    if (reservation.outcome === 'existing') {
      return {
        ...structuredClone(reservation.result),
        metadata: {
          ...this.metadata(registration, startedAt, 0, request.idempotencyKey),
          replayed: true,
        },
      };
    }
    const code: ToolErrorCode = reservation.outcome === 'conflict'
      ? 'idempotency_conflict'
      : reservation.outcome === 'unresolved'
        ? 'uncertain_side_effect'
        : 'duplicate_in_progress';
    const message = reservation.outcome === 'conflict'
      ? '同一幂等键对应了不同工具请求'
      : reservation.outcome === 'unresolved'
        ? '工具副作用状态无法确认，已禁止自动重放'
        : '同一幂等调用仍在执行中';
    return this.failure(
      code,
      message,
      false,
      registration,
      startedAt,
      0,
      undefined,
      request.idempotencyKey,
    );
  }

  /** 根据风险和适配器幂等能力决定最大尝试次数。 */
  private maxAttempts(
    registration: ToolRegistration,
    request: ToolInvocationRequest,
  ): number {
    if (registration.descriptor.risk === 'read') {
      return this.maxReadAttempts;
    }
    return registration.supportsIdempotency && request.idempotencyKey
      ? this.maxReadAttempts
      : 1;
  }

  /** 组合外部 Signal 与本次尝试超时，并在终止后停止消费迟到结果。 */
  private async executeAttempt(
    registration: ToolRegistration,
    request: ToolInvocationRequest,
    attempt: number,
  ): Promise<AttemptOutcome> {
    if (request.signal?.aborted) {
      return { kind: 'cancelled', message: '工具调用已取消' };
    }

    const controller = new AbortController();
    let timedOut = false;
    // 外部取消只负责中止本次尝试，不复用或反向修改调用方的 Signal。
    const cancel = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('工具调用超时'));
    }, registration.descriptor.timeoutMs);

    try {
      const invocation = Promise.resolve().then(() => registration.invoke(
        request.arguments,
        {
          signal: controller.signal,
          attempt,
          idempotencyKey: request.idempotencyKey,
        },
      ));
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(controller.signal.reason ?? new Error('工具调用已取消')),
          { once: true },
        );
      });
      const result = await Promise.race([invocation, aborted]);
      return { kind: 'result', result };
    } catch (error) {
      if (timedOut) {
        return { kind: 'timeout', message: `工具调用超过 ${registration.descriptor.timeoutMs}ms` };
      }
      if (request.signal?.aborted) {
        return { kind: 'cancelled', message: '工具调用已取消' };
      }
      return {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', cancel);
    }
  }

  /** 把一次尝试的返回值或异常统一转换成结构化 ToolResult。 */
  private resultFromAttempt(
    outcome: AttemptOutcome,
    registration: ToolRegistration,
    request: ToolInvocationRequest,
    startedAt: number,
    attempt: number,
  ): ToolResult {
    if (outcome.kind === 'result' && outcome.result.success) {
      return {
        ...outcome.result,
        error: undefined,
        metadata: this.metadata(
          registration,
          startedAt,
          attempt,
          request.idempotencyKey,
        ),
      };
    }
    if (outcome.kind === 'cancelled') {
      return this.failure(
        'cancelled',
        outcome.message,
        false,
        registration,
        startedAt,
        attempt,
        undefined,
        request.idempotencyKey,
      );
    }
    if (outcome.kind === 'timeout') {
      return this.failure(
        'timeout',
        outcome.message,
        true,
        registration,
        startedAt,
        attempt,
        undefined,
        request.idempotencyKey,
      );
    }
    const message = outcome.kind === 'result'
      ? outcome.result.error?.message ?? outcome.result.message ?? '工具返回失败'
      : outcome.message;
    const retryable = outcome.kind === 'result'
      ? outcome.result.error?.retryable ?? false
      : true;
    return this.failure(
      'execution_failed',
      message,
      retryable,
      registration,
      startedAt,
      attempt,
      outcome.kind === 'result' ? outcome.result.error?.details : undefined,
      request.idempotencyKey,
    );
  }

  /** 创建所有失败路径共用的稳定结果外形。 */
  private failure(
    code: ToolErrorCode,
    message: string,
    retryable: boolean,
    registration: ToolRegistration | undefined,
    startedAt: number,
    attempts: number,
    details?: unknown,
    idempotencyKey?: string,
  ): ToolResult {
    return {
      success: false,
      message,
      error: { code, message, retryable, ...(details === undefined ? {} : { details }) },
      ...(registration
        ? { metadata: this.metadata(registration, startedAt, attempts, idempotencyKey) }
        : {}),
    };
  }

  /** 根据当前耗时和注册能力生成统一调用元数据。 */
  private metadata(
    registration: ToolRegistration,
    startedAt: number,
    attempts: number,
    idempotencyKey?: string,
  ): ToolResultMetadata {
    return {
      attempts,
      durationMs: Math.max(0, this.clock() - startedAt),
      risk: registration.descriptor.risk,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      signalPropagation: registration.supportsAbortSignal ? 'forwarded' : 'guarded',
    };
  }
}

/** 校验当前项目 Tool Schema 使用的 object/required/type 子集并返回字段错误。 */
export function validateToolArguments(
  arguments_: Record<string, unknown>,
  schema: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  if (schema.type && schema.type !== 'object') {
    return ['根 Schema 必须是 object'];
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : [];
  for (const field of required) {
    if (!Object.hasOwn(arguments_, field) || arguments_[field] === undefined) {
      errors.push(`${field} 为必填字段`);
    }
  }
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return errors;
  }
  for (const [field, definition] of Object.entries(properties)) {
    if (!Object.hasOwn(arguments_, field) || arguments_[field] === undefined) {
      continue;
    }
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      continue;
    }
    const expected = (definition as Record<string, unknown>).type;
    if (typeof expected === 'string' && !matchesJsonType(arguments_[field], expected)) {
      errors.push(`${field} 必须是 ${expected}`);
    }
  }
  return errors;
}

/** 判断一个运行时值是否符合 JSON Schema 的基础类型。 */
function matchesJsonType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    case 'null': return value === null;
    default: return true;
  }
}

/** 生成不受对象键顺序影响的工具请求指纹。 */
function fingerprint(functionName: string, arguments_: Record<string, unknown>): string {
  return createHash('sha256')
    .update(stableSerialize({ functionName, arguments: arguments_ }))
    .digest('hex');
}

/** 递归排序对象键，确保语义相同的参数产生同一序列化结果。 */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** 组合 scope 与幂等键，避免不同 Run/Session 相互覆盖。 */
function storageKey(scopeId: string, idempotencyKey: string): string {
  return `${scopeId.length}:${scopeId}${idempotencyKey}`;
}
