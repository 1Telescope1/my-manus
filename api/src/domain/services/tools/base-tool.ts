import { ToolResult } from '../../models/tool-result';

export type ToolSchema = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required: string[];
    };
  };
};

type ToolMethod = ((...args: any[]) => Promise<ToolResult>) & {
  toolName?: string;
  toolSchema?: ToolSchema;
};

export function tool(input: {
  name: string;
  description: string;
  parameters: Record<string, any>;
  required: string[];
}): MethodDecorator {
  return (_target, _propertyKey, descriptor) => {
    const method = descriptor.value as ToolMethod;
    method.toolName = input.name;
    method.toolSchema = {
      type: 'function',
      function: {
        name: input.name,
        description: input.description,
        parameters: {
          type: 'object',
          properties: input.parameters,
          required: input.required,
        },
      },
    };
  };
}

export abstract class BaseTool {
  abstract readonly name: string;
  private toolsCache?: ToolSchema[];

  getTools(): ToolSchema[] {
    if (this.toolsCache) {
      return this.toolsCache;
    }

    const prototype = Object.getPrototypeOf(this);
    const schemas = Object.getOwnPropertyNames(prototype)
      .map((propertyName) => (this as any)[propertyName] as ToolMethod)
      .filter((method) => typeof method === 'function' && Boolean(method.toolSchema))
      .map((method) => method.toolSchema as ToolSchema);

    this.toolsCache = schemas;
    return schemas;
  }

  hasTool(toolName: string): boolean {
    return this.getToolMethod(toolName) !== undefined;
  }

  async invoke(toolName: string, kwargs: Record<string, any> = {}): Promise<ToolResult> {
    const method = this.getToolMethod(toolName);
    if (!method) {
      throw new Error(`工具[${toolName}]未找到`);
    }

    return method.call(this, ...this.buildArguments(method, kwargs));
  }

  private getToolMethod(toolName: string): ToolMethod | undefined {
    const prototype = Object.getPrototypeOf(this);
    for (const propertyName of Object.getOwnPropertyNames(prototype)) {
      const method = (this as any)[propertyName] as ToolMethod;
      if (typeof method === 'function' && method.toolName === toolName) {
        return method;
      }
    }
    return undefined;
  }

  private buildArguments(method: ToolMethod, kwargs: Record<string, any>): any[] {
    const schema = method.toolSchema;
    if (!schema) {
      return [];
    }
    return Object.keys(schema.function.parameters.properties).map((key) => kwargs[key]);
  }
}
