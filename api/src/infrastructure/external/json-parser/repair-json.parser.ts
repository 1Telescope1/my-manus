import { Injectable, Logger } from '@nestjs/common';
import { jsonrepair } from 'jsonrepair';
import { JSONParser } from '../../../domain/external/json-parser';

@Injectable()
export class RepairJSONParser extends JSONParser {
  private readonly logger = new Logger(RepairJSONParser.name);

  async invoke<T = unknown>(text: string, defaultValue?: T): Promise<T> {
    this.logger.debug(`解析 JSON 文本: ${JSON.stringify(text)}`);
    if (!text || !text.trim()) {
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new Error('JSON 文本为空，且无默认值');
    }

    const normalized = this.normalizeJsonText(text);

    try {
      return JSON.parse(jsonrepair(normalized)) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`模型返回的 JSON 无法解析: ${message}; 原始内容: ${JSON.stringify(text)}`);
      throw new Error(`模型返回的 JSON 无法解析: ${message}`);
    }
  }

  private normalizeJsonText(text: string): string {
    let normalized = text.trim();

    // 模型有时会把 JSON 包在 Markdown 代码块中。
    normalized = normalized
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    // 兼容 JSON 前后附带简短说明文字的情况。
    const objectStart = normalized.indexOf('{');
    const arrayStart = normalized.indexOf('[');
    const starts = [objectStart, arrayStart].filter((index) => index >= 0);
    const start = starts.length > 0 ? Math.min(...starts) : -1;
    const end = Math.max(normalized.lastIndexOf('}'), normalized.lastIndexOf(']'));

    if (start >= 0 && end >= start) {
      return normalized.slice(start, end + 1);
    }

    return normalized;
  }
}
