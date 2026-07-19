import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { SearchEngine } from '../../../domain/external/search-engine';
import { SearchResultItem, SearchResults } from '../../../domain/models/search';
import { ToolResult } from '../../../domain/models/tool-result';

@Injectable()
export class BingSearchEngine extends SearchEngine {
  private readonly logger = new Logger(BingSearchEngine.name);
  private readonly baseUrl = 'https://www.bing.com/search';
  private readonly headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  };

  async invoke(
    query: string,
    dateRange?: string | null,
    signal?: AbortSignal,
  ): Promise<ToolResult<SearchResults>> {
    const url = new URL(this.baseUrl);
    url.searchParams.set('q', query);

    if (dateRange && dateRange !== 'all') {
      const daysSinceEpoch = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
      const dateMapping: Record<string, string> = {
        past_hour: 'ex1%3a"ez1"',
        past_day: 'ex1%3a"ez1"',
        past_week: 'ex1%3a"ez2"',
        past_month: 'ex1%3a"ez3"',
        past_year: `ex1%3a"ez5_${daysSinceEpoch - 365}_${daysSinceEpoch}"`,
      };
      if (dateRange in dateMapping) {
        url.searchParams.set('filters', dateMapping[dateRange]);
      }
    }

    try {
      const response = await fetch(url, {
        headers: this.headers,
        redirect: 'follow',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
          : AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        throw new Error(`Bing returned ${response.status}`);
      }

      const html = await response.text();
      const $ = cheerio.load(html);
      const searchResults: SearchResultItem[] = [];

      $('li.b_algo').each((_index, element) => {
        try {
          const item = $(element);
          let title = item.find('h2 a').first().text().trim();
          let href = item.find('h2 a').first().attr('href') ?? '';

          if (!title) {
            item.find('a').each((_i, anchor) => {
              if (title) {
                return;
              }
              const text = $(anchor).text().trim();
              if (text.length > 10 && !text.startsWith('http')) {
                title = text;
                href = $(anchor).attr('href') ?? '';
              }
            });
          }

          if (!title) {
            return;
          }

          let snippet = item
            .find('p,div')
            .filter((_i, node) => {
              const className = $(node).attr('class') ?? '';
              return /b_lineclamp|b_descript|b_caption/.test(className);
            })
            .first()
            .text()
            .trim();

          if (!snippet) {
            item.find('p').each((_i, paragraph) => {
              if (snippet) {
                return;
              }
              const text = $(paragraph).text().trim();
              if (text.length > 20) {
                snippet = text;
              }
            });
          }

          if (!snippet) {
            const allText = item.text().trim();
            const sentence = allText
              .split(/[.!?\n。！]/)
              .map((value) => value.trim())
              .find((value) => value.length > 20 && value !== title);
            snippet = sentence ?? '';
          }

          if (href && !href.startsWith('http')) {
            if (href.startsWith('//')) {
              href = `https:${href}`;
            } else if (href.startsWith('/')) {
              href = `https://www.bing.com${href}`;
            }
          }

          searchResults.push({ title, url: href, snippet });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.logger.warn(`Bing搜索结果解析失败: ${err.message}`);
          return;
        }
      });

      let totalResults = 0;
      const bodyText = $('body').text();
      const countMatch = bodyText.match(/([\d,]+)\s*results/i);
      if (countMatch?.[1]) {
        totalResults = Number(countMatch[1].replace(/,/g, '')) || 0;
      }

      return {
        success: true,
        data: {
          query,
          date_range: dateRange,
          total_results: totalResults,
          results: searchResults,
        },
      };
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Bing搜索出错: ${err.message}`);
      return {
        success: false,
        message: `Bing搜索出错: ${err.message}`,
        data: {
          query,
          date_range: dateRange,
          total_results: 0,
          results: [],
        },
      };
    }
  }
}
