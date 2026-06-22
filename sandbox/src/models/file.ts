export type FileReadResult = {
  filepath: string;
  content: string;
};

export type FileWriteResult = {
  filepath: string;
  bytes_written?: number | null;
};

export type FileReplaceResult = {
  filepath: string;
  replaced_count: number;
};

export type FileSearchResult = {
  filepath: string;
  matches: string[];
  line_numbers: number[];
};

export type FileFindResult = {
  dir_path: string;
  files: string[];
};

export type FileUploadResult = {
  filepath: string;
  file_size: number;
  success: boolean;
};

export type FileCheckResult = {
  filepath: string;
  exists: boolean;
};

export type FileDeleteResult = {
  filepath: string;
  deleted: boolean;
};
