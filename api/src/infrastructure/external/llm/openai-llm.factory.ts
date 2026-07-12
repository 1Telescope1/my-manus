import { Injectable } from '@nestjs/common';
import { LLM, LLMFactory } from '../../../domain/external/llm';
import { LLMConfig } from '../../../domain/models/app-config';
import { OpenAILLM } from './openai-llm';

/** 使用应用配置创建 OpenAI 兼容模型客户端。 */
@Injectable()
export class OpenAILLMFactory extends LLMFactory<LLMConfig> {
  create(config: LLMConfig): LLM {
    return new OpenAILLM(config);
  }
}
