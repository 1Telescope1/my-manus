import {
  ToolDescriptor,
  ToolRegistration,
  ToolRisk,
} from '../../models/tool';
import { ToolResult } from '../../models/tool-result';

const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

type ToolDefinition = Omit<ToolDescriptor, 'id' | 'source' | 'capabilities'> & {
  capabilities?: string[];
};

type ToolMethod = ((...args: any[]) => Promise<ToolResult>) & {
  toolName?: string;
  toolDefinition?: ToolDefinition;
};

/** 为内置工具方法声明通用描述元数据。 */
export function tool(input: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  required: string[];
  capabilities?: string[];
  risk?: ToolRisk;
  requiresApproval?: boolean;
  timeoutMs?: number;
}): MethodDecorator {
  return (_target, _propertyKey, descriptor) => {
    const method = descriptor.value as ToolMethod;
    method.toolName = input.name;
    method.toolDefinition = {
      name: input.name,
      description: input.description,
      inputSchema: {
        type: 'object',
        properties: input.parameters,
        required: input.required,
      },
      capabilities: input.capabilities,
      risk: input.risk ?? 'read',
      requiresApproval: input.requiresApproval ?? false,
      timeoutMs: input.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    };
  };
}

/** 现有工具包的领域基类，可把装饰器方法导出为 Registry 注册项。 */
export abstract class BaseTool {
  abstract readonly name: string;
  private registrationsCache?: ToolRegistration[];

  /** 将当前工具包中的装饰器方法转换为内置工具注册项。 */
  getRegistrations(): ToolRegistration[] {
    if (!this.registrationsCache) {
      this.registrationsCache = this.getToolMethods().map((method) => {
        const definition = method.toolDefinition as ToolDefinition;
        return {
          descriptor: {
            ...definition,
            id: `builtin:${definition.name}`,
            source: 'builtin',
            capabilities: definition.capabilities?.length
              ? [...definition.capabilities]
              : [this.name],
          },
          groupName: this.name,
          invoke: (arguments_) => this.invoke(definition.name, arguments_),
        };
      });
    }
    return this.registrationsCache.map((registration) => ({
      ...registration,
      descriptor: {
        ...registration.descriptor,
        inputSchema: structuredClone(registration.descriptor.inputSchema),
        capabilities: [...registration.descriptor.capabilities],
      },
    }));
  }

  /** 判断工具包是否包含指定模型可见函数名。 */
  hasTool(toolName: string): boolean {
    return this.getToolMethod(toolName) !== undefined;
  }

  /** 按输入 Schema 的属性顺序组装参数并调用工具方法。 */
  async invoke(toolName: string, kwargs: Record<string, any> = {}): Promise<ToolResult> {
    const method = this.getToolMethod(toolName);
    if (!method) {
      throw new Error(`工具[${toolName}]未找到`);
    }
    return method.call(this, ...this.buildArguments(method, kwargs));
  }

  /** 返回原型上全部带 Tool 元数据的方法。 */
  private getToolMethods(): ToolMethod[] {
    const prototype = Object.getPrototypeOf(this);
    return Object.getOwnPropertyNames(prototype)
      .map((propertyName) => (this as any)[propertyName] as ToolMethod)
      .filter((method) => typeof method === 'function' && Boolean(method.toolDefinition));
  }

  /** 按模型可见函数名定位实际方法。 */
  private getToolMethod(toolName: string): ToolMethod | undefined {
    return this.getToolMethods().find((method) => method.toolName === toolName);
  }

  /** 按 Schema 属性顺序把命名参数转换为方法位置参数。 */
  private buildArguments(method: ToolMethod, kwargs: Record<string, any>): any[] {
    const properties = method.toolDefinition?.inputSchema.properties;
    if (!properties || typeof properties !== 'object') {
      return [];
    }
    return Object.keys(properties).map((key) => kwargs[key]);
  }
}
