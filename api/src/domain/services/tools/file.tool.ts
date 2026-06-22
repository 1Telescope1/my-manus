import { Sandbox } from '../../external/sandbox';
import { ToolResult } from '../../models/tool-result';
import { BaseTool, tool } from './base-tool';

export class FileTool extends BaseTool {
  readonly name = 'file';

  constructor(private readonly sandbox: Sandbox) {
    super();
  }

  @tool({
    name: 'read_file',
    description: '读取文件内容。用于检查文件内容、分析日志或读取配置文件。',
    parameters: {
      filepath: {
        type: 'string',
        description: '要读取文件的绝对路径',
      },
      start_line: {
        type: 'integer',
        description: '(可选)读取的起始行, 索引从 0 开始',
      },
      end_line: {
        type: 'integer',
        description: '(可选)结束行号, 不包含该行',
      },
      sudo: {
        type: 'boolean',
        description: '(可选)是否使用 sudo 权限',
      },
      max_length: {
        type: 'integer',
        description: '(可选)读取文件内容的最大长度, 默认为10000',
      },
    },
    required: ['filepath'],
  })
  async readFile(
    filepath: string,
    startLine?: number,
    endLine?: number,
    sudo = false,
    maxLength = 10000,
  ): Promise<ToolResult> {
    return this.sandbox.readFile(filepath, startLine, endLine, sudo, maxLength);
  }

  @tool({
    name: 'write_file',
    description: '对文件进行覆盖或追加写入。用于创建新文件、追加内容或修改现有文件。',
    parameters: {
      filepath: {
        type: 'string',
        description: '要写入文件的绝对路径',
      },
      content: {
        type: 'string',
        description: '要写入的文本内容',
      },
      append: {
        type: 'boolean',
        description: '(可选)是否使用追加模式',
      },
      leading_newline: {
        type: 'boolean',
        description: '(可选)是否添加前置换行符, 在内容开头',
      },
      trailing_newline: {
        type: 'boolean',
        description: '(可选)是否添加后置换行符, 在内容结尾',
      },
      sudo: {
        type: 'boolean',
        description: '(可选)是否使用 sudo 权限',
      },
    },
    required: ['filepath', 'content'],
  })
  async writeFile(
    filepath: string,
    content: string,
    append = false,
    leadingNewline = false,
    trailingNewline = false,
    sudo = false,
  ): Promise<ToolResult> {
    return this.sandbox.writeFile(
      filepath,
      content,
      append,
      leadingNewline,
      trailingNewline,
      sudo,
    );
  }

  @tool({
    name: 'replace_in_file',
    description: '在文件中替换指定的字符串。用于更新文件中的特定内容或修复代码中的错误。',
    parameters: {
      filepath: {
        type: 'string',
        description: '要执行替换操作的文件的绝对路径',
      },
      old_str: {
        type: 'string',
        description: '要被替换的原始字符串',
      },
      new_str: {
        type: 'string',
        description: '用于替换的新字符串',
      },
      sudo: {
        type: 'boolean',
        description: '(可选)是否使用 sudo 权限',
      },
    },
    required: ['filepath', 'old_str', 'new_str'],
  })
  async replaceInFile(
    filepath: string,
    oldStr: string,
    newStr: string,
    sudo = false,
  ): Promise<ToolResult> {
    return this.sandbox.replaceInFile(filepath, oldStr, newStr, sudo);
  }

  @tool({
    name: 'search_in_file',
    description: '在文件内容中搜索匹配的文本。用于查找文件中的特定内容或模式。',
    parameters: {
      filepath: {
        type: 'string',
        description: '要进行搜索的文件的绝对路径',
      },
      regex: {
        type: 'string',
        description: '用于匹配的正则表达式模式',
      },
      sudo: {
        type: 'boolean',
        description: '(可选)是否使用 sudo 权限',
      },
    },
    required: ['filepath', 'regex'],
  })
  async searchInFile(filepath: string, regex: string, sudo = false): Promise<ToolResult> {
    return this.sandbox.searchInFile(filepath, regex, sudo);
  }

  @tool({
    name: 'find_files',
    description: '在指定目录中根据名称模式查找文件。用于定位具有特定命名模式的文件。',
    parameters: {
      dir_path: {
        type: 'string',
        description: '要搜索的目录的绝对路径',
      },
      glob_pattern: {
        type: 'string',
        description: '使用 glob 语法通配符的文件名模式',
      },
    },
    required: ['dir_path', 'glob_pattern'],
  })
  async findFiles(dirPath: string, globPattern: string): Promise<ToolResult> {
    return this.sandbox.findFiles(dirPath, globPattern);
  }
}
