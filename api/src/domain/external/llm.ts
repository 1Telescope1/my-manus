import { ToolDescriptor } from '../models/tool';

export type LLMMessage = Record<string, any>;

export abstract class LLM {
  abstract readonly modelName: string;
  abstract readonly temperature: number;
  abstract readonly maxTokens: number;

  /** 模型总上下文窗口；旧测试模型未声明时使用保守兼容默认值。 */
  get contextWindowTokens(): number {
    return Math.max(32_768, this.maxTokens * 4);
  }

  abstract invoke(input: {
    messages: LLMMessage[];
    tools?: ToolDescriptor[];
    responseFormat?: Record<string, any> | null;
    toolChoice?: string | null;
    signal?: AbortSignal;
  }): Promise<LLMMessage>;
}

/** 根据运行时配置创建独立的模型客户端。 */
export abstract class LLMFactory<TConfig = unknown> {
  abstract create(config: TConfig): LLM;
}
