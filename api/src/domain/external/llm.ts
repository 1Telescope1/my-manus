export type LLMMessage = Record<string, any>;

export abstract class LLM {
  abstract readonly modelName: string;
  abstract readonly temperature: number;
  abstract readonly maxTokens: number;

  abstract invoke(input: {
    messages: LLMMessage[];
    tools?: Record<string, any>[];
    responseFormat?: Record<string, any> | null;
    toolChoice?: string | null;
  }): Promise<LLMMessage>;
}
