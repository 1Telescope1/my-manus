export type SearchResultItem = {
  url: string;
  title: string;
  snippet: string;
};

export type SearchResults = {
  query: string;
  date_range?: string | null;
  total_results: number;
  results: SearchResultItem[];
};
