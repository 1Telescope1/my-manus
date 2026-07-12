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

    // 优先从 Markdown JSON 代码块开始查找，但不依赖结束围栏存在。
    const fencedStart = /```(?:json)?\s*/i.exec(normalized);
    if (fencedStart) {
      normalized = normalized.slice(fencedStart.index + fencedStart[0].length);
    }

    const start = this.findJsonStart(normalized);
    if (start < 0) {
      return normalized.replace(/\s*```\s*$/i, '').trim();
    }

    const end = this.findCompleteJsonEnd(normalized, start);
    if (end >= 0) {
      // 只提取第一个结构完整的 JSON 值，忽略其后的 Markdown 说明。
      return normalized.slice(start, end + 1);
    }

    // 结构不完整时保留从起始符开始的内容，交给 jsonrepair 尝试修复。
    return normalized.slice(start).replace(/\s*```\s*$/i, '').trim();
  }

  private findJsonStart(text: string): number {
    const objectStart = text.indexOf('{');
    const arrayStart = text.indexOf('[');
    const starts = [objectStart, arrayStart].filter((index) => index >= 0);
    return starts.length > 0 ? Math.min(...starts) : -1;
  }

  private findCompleteJsonEnd(text: string, start: number): number {
    const stack: string[] = [];
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === '{' || char === '[') {
        stack.push(char);
      } else if (char === '}' || char === ']') {
        const expectedOpen = char === '}' ? '{' : '[';
        if (stack.pop() !== expectedOpen) {
          return -1;
        }
        if (stack.length === 0) {
          return index;
        }
      }
    }

    return -1;
  }
}
