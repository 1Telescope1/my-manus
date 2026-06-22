import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** 读取文件请求结构体。 */
export class FileReadRequest {
  @ApiProperty({ description: '要读取文件的绝对路径' })
  filepath!: string;

  @ApiPropertyOptional({ description: '(可选)读取的起始行, 索引从0开始' })
  start_line?: number;

  @ApiPropertyOptional({ description: '(可选)结束行号, 不包含该行' })
  end_line?: number;

  @ApiPropertyOptional({ default: false, description: '(可选)是否使用sudo权限' })
  sudo?: boolean;

  @ApiPropertyOptional({ default: 10000, description: '(可选)要返回的内容的最大长度' })
  max_length?: number | null;
}

/** 写入文件请求结构体。 */
export class FileWriteRequest {
  @ApiProperty({ description: '要写入文件的绝对路径' })
  filepath!: string;

  @ApiProperty({ description: '要写入的文本内容' })
  content!: string;

  @ApiPropertyOptional({ default: false, description: '(可选)是否使用追加模式' })
  append?: boolean;

  @ApiPropertyOptional({ default: false, description: '(可选)是否在内容开头添加前置空行' })
  leading_newline?: boolean;

  @ApiPropertyOptional({ default: false, description: '(可选)是否在内容结尾添加前置空行' })
  trailing_newline?: boolean;

  @ApiPropertyOptional({ default: false, description: '(可选)是否使用sudo权限' })
  sudo?: boolean;
}

/** 查找替换文件内容请求结构体。 */
export class FileReplaceRequest {
  @ApiProperty({ description: '要替换内容的文件绝对路径' })
  filepath!: string;

  @ApiProperty({ description: '要替换的原始字符串' })
  old_str!: string;

  @ApiProperty({ description: '要替换的新字符串' })
  new_str!: string;

  @ApiPropertyOptional({ default: false, description: '(可选)是否使用sudo权限' })
  sudo?: boolean;
}

/** 文件内容查找请求结构体。 */
export class FileSearchRequest {
  @ApiProperty({ description: '要查找内容的文件绝对路径' })
  filepath!: string;

  @ApiProperty({ description: '搜索正则表达式' })
  regex!: string;

  @ApiPropertyOptional({ default: false, description: '(可选)是否使用sudo权限' })
  sudo?: boolean;
}

/** 文件查找请求结构体。 */
export class FileFindRequest {
  @ApiProperty({ description: '搜索的目录绝对路径' })
  dir_path!: string;

  @ApiProperty({ description: '文件名模式(glob语法)' })
  glob_pattern!: string;
}

/** 检查文件是否存在请求结构体。 */
export class FileCheckRequest {
  @ApiProperty({ description: '要检查是否存在的文件绝对路径' })
  filepath!: string;
}

/** 删除文件请求结构体。 */
export class FileDeleteRequest {
  @ApiProperty({ description: '要删除的文件绝对路径' })
  filepath!: string;
}
