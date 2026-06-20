import { SearchResults } from '../models/search';
import { ToolResult } from '../models/tool-result';

export abstract class SearchEngine {
  abstract invoke(query: string, dateRange?: string | null): Promise<ToolResult<SearchResults>>;
}
