import {
  ToolDescriptor,
  ToolQuery,
  ToolRegistration,
  ToolRegistry,
} from '../../models/tool';

/** 工具 id 或 name 冲突时抛出的稳定领域错误。 */
export class ToolConflictError extends Error {
  /** 保存冲突字段和值，便于装配阶段诊断。 */
  constructor(
    readonly field: 'id' | 'name',
    readonly value: string,
  ) {
    super(`工具${field}冲突: ${value}`);
    this.name = 'ToolConflictError';
  }
}

/** 工具描述不满足领域不变量时抛出的稳定错误。 */
export class InvalidToolDescriptorError extends Error {
  /** 记录无效描述的稳定 id 和原因。 */
  constructor(readonly descriptorId: string, reason: string) {
    super(`工具描述[${descriptorId || '<empty>'}]无效: ${reason}`);
    this.name = 'InvalidToolDescriptorError';
  }
}

/** 使用进程内索引实现供应商中立 Tool Registry。 */
export class InMemoryToolRegistry implements ToolRegistry {
  private readonly registrationsById = new Map<string, ToolRegistration>();
  private readonly idsByName = new Map<string, string>();

  /** 注册一个工具，并复用批量注册的原子校验语义。 */
  register(registration: ToolRegistration): void {
    this.registerAll([registration]);
  }

  /** 原子注册一批工具，并同时检测批内与已有 id/name 冲突。 */
  registerAll(registrations: readonly ToolRegistration[]): void {
    const pendingIds = new Set<string>();
    const pendingNames = new Set<string>();

    // 先完成全部校验，保证最后写入阶段不会留下半注册状态。
    for (const registration of registrations) {
      validateRegistration(registration);
      const { id, name } = registration.descriptor;
      if (this.registrationsById.has(id) || pendingIds.has(id)) {
        throw new ToolConflictError('id', id);
      }
      if (this.idsByName.has(name) || pendingNames.has(name)) {
        throw new ToolConflictError('name', name);
      }
      pendingIds.add(id);
      pendingNames.add(name);
    }

    for (const registration of registrations) {
      const snapshot = cloneRegistration(registration);
      this.registrationsById.set(snapshot.descriptor.id, snapshot);
      this.idsByName.set(snapshot.descriptor.name, snapshot.descriptor.id);
    }
  }

  /** 按稳定 id 返回隔离于 Registry 内部状态的描述快照。 */
  getById(id: string): ToolDescriptor | undefined {
    const descriptor = this.registrationsById.get(id)?.descriptor;
    return descriptor ? cloneDescriptor(descriptor) : undefined;
  }

  /** 按模型可见 name 返回隔离于 Registry 内部状态的描述快照。 */
  getByName(name: string): ToolDescriptor | undefined {
    const id = this.idsByName.get(name);
    return id ? this.getById(id) : undefined;
  }

  /** 按来源、名称、风险和 capability 的交集查询描述。 */
  list(query: ToolQuery = {}): ToolDescriptor[] {
    return [...this.registrationsById.values()]
      .map((registration) => registration.descriptor)
      .filter((descriptor) => matchesQuery(descriptor, query))
      .map(cloneDescriptor);
  }

  /** 按模型可见 name 解析调用目标，并返回描述快照与原始执行函数。 */
  resolve(name: string): ToolRegistration | undefined {
    const id = this.idsByName.get(name);
    const registration = id ? this.registrationsById.get(id) : undefined;
    return registration ? cloneRegistration(registration) : undefined;
  }
}

/** 校验注册项的最小领域不变量。 */
function validateRegistration(registration: ToolRegistration): void {
  const { descriptor } = registration;
  if (!descriptor.id.trim()) {
    throw new InvalidToolDescriptorError(descriptor.id, 'id 不能为空');
  }
  if (!descriptor.name.trim()) {
    throw new InvalidToolDescriptorError(descriptor.id, 'name 不能为空');
  }
  if (!descriptor.description.trim()) {
    throw new InvalidToolDescriptorError(descriptor.id, 'description 不能为空');
  }
  if (!Number.isFinite(descriptor.timeoutMs) || descriptor.timeoutMs <= 0) {
    throw new InvalidToolDescriptorError(descriptor.id, 'timeoutMs 必须是正数');
  }
  if (!registration.groupName.trim()) {
    throw new InvalidToolDescriptorError(descriptor.id, 'groupName 不能为空');
  }
  if (typeof registration.invoke !== 'function') {
    throw new InvalidToolDescriptorError(descriptor.id, 'invoke 必须是函数');
  }
}

/** 判断一个描述是否满足全部查询条件。 */
function matchesQuery(descriptor: ToolDescriptor, query: ToolQuery): boolean {
  return (!query.ids?.length || query.ids.includes(descriptor.id))
    && (!query.names?.length || query.names.includes(descriptor.name))
    && (!query.sources?.length || query.sources.includes(descriptor.source))
    && (!query.risks?.length || query.risks.includes(descriptor.risk))
    && (!query.capabilities?.length || query.capabilities.every(
      (capability) => descriptor.capabilities.includes(capability),
    ));
}

/** 复制 Descriptor 的可变数组和 Schema，防止查询方修改 Registry 索引。 */
function cloneDescriptor(descriptor: ToolDescriptor): ToolDescriptor {
  return {
    ...descriptor,
    inputSchema: structuredClone(descriptor.inputSchema),
    capabilities: [...descriptor.capabilities],
  };
}

/** 复制注册项的描述，同时保留同一个执行函数。 */
function cloneRegistration(registration: ToolRegistration): ToolRegistration {
  return {
    ...registration,
    descriptor: cloneDescriptor(registration.descriptor),
  };
}
