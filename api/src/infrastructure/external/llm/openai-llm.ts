import OpenAI from 'openai';
import { LLM, LLMMessage } from '../../../domain/external/llm';
import { LLMConfig } from '../../../domain/models/app-config';
import { ServerRequestsError } from '../../../core/errors/app-exception';

export class OpenAILLM extends LLM {
  private readonly client: OpenAI;
  private readonly timeout = 3_600_000;

  constructor(private readonly llmConfig: LLMConfig, options: ConstructorParameters<typeof OpenAI>[0] = {}) {
    super();
    this.client = new OpenAI({
      baseURL: llmConfig.base_url,
      apiKey: llmConfig.api_key,
      ...options,
    });
  }

  get modelName(): string {
    return this.llmConfig.model_name;
  }

  get temperature(): number {
    return this.llmConfig.temperature;
  }

  get maxTokens(): number {
    return this.llmConfig.max_tokens;
  }

  async invoke(input: {
    messages: LLMMessage[];
    tools?: Record<string, any>[];
    responseFormat?: Record<string, any> | null;
    toolChoice?: string | null;
  }): Promise<LLMMessage> {
    try {
      const common = {
        model: this.modelName,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        messages: input.messages as any,
        response_format: input.responseFormat as any,
        timeout: this.timeout,
      };

      const response = input.tools?.length
        ? await this.client.chat.completions.create({
            ...common,
            tools: input.tools as any,
            tool_choice: input.toolChoice as any,
            parallel_tool_calls: false,
          } as any)
        : await this.client.chat.completions.create(common as any);

      return response.choices[0]?.message as unknown as LLMMessage;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      throw new ServerRequestsError(`调用OpenAI客户端向LLM发起请求出错: ${err.message}`);
    }
  }
}
