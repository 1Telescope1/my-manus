import { Injectable, Logger } from '@nestjs/common';
import { jsonrepair } from 'jsonrepair';
import { JSONParser } from '../../../domain/external/json-parser';

@Injectable()
export class RepairJSONParser extends JSONParser {
  private readonly logger = new Logger(RepairJSONParser.name);

  async invoke<T = unknown>(text: string, defaultValue?: T): Promise<T> {
    this.logger.debug(`解析json文本: ${text}`);
    if (!text || !text.trim()) {
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new Error('json文本为空，且无默认值');
    }

    return JSON.parse(jsonrepair(text)) as T;
  }
}
