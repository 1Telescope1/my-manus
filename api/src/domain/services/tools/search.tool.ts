import { SearchEngine } from '../../external/search-engine';
import { SearchResults } from '../../models/search';
import { ToolResult } from '../../models/tool-result';
import { BaseTool, tool } from './base-tool';

export class SearchTool extends BaseTool {
  readonly name = 'search';

  constructor(private readonly searchEngine: SearchEngine) {
    super();
  }

  @tool({
    name: 'search_web',
    capabilities: ['search', 'web.search'],
    description:
      '全网搜索引擎工具。当需要获取实时信息、补充内部知识库未覆盖的内容或进行事实核查时使用。该工具会返回相关的网页摘要和链接。',
    parameters: {
      query: {
        type: 'string',
        description:
          '针对搜索引擎优化的查询字符串。请提取问题中的核心实体和关键词，避免使用完整的自然语言问句。',
      },
      date_range: {
        type: 'string',
        enum: ['all', 'past_hour', 'past_day', 'past_week', 'past_month', 'past_year'],
        description: '搜索结果的时间范围过滤。默认值为 all。',
      },
    },
    required: ['query'],
  })
  async searchWeb(query: string, dateRange?: string): Promise<ToolResult<SearchResults>> {
    return this.searchEngine.invoke(query, dateRange);
  }
}
