import { ToolDescriptor } from '../models/tool';

export type LLMMessage = Record<string, any>;

export abstract class LLM {
  abstract readonly modelName: string;
  abstract readonly temperature: number;
  abstract readonly maxTokens: number;

  abstract invoke(input: {
    messages: LLMMessage[];
    tools?: ToolDescriptor[];
    responseFormat?: Record<string, any> | null;
    toolChoice?: string | null;
  }): Promise<LLMMessage>;
}

/** 根据运行时配置创建独立的模型客户端。 */
export abstract class LLMFactory<TConfig = unknown> {
  abstract create(config: TConfig): LLM;
}
