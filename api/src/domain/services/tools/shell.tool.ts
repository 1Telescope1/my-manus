import { Sandbox } from '../../external/sandbox';
import { ToolResult } from '../../models/tool-result';
import { BaseTool, tool } from './base-tool';

export class ShellTool extends BaseTool {
  readonly name = 'shell';

  constructor(private readonly sandbox: Sandbox) {
    super();
  }

  @tool({
    name: 'shell_execute',
    description: '在指定 Shell 会话中执行命令。可用于运行代码、安装依赖包或文件管理。',
    parameters: {
      session_id: {
        type: 'string',
        description: '目标 Shell 会话的唯一标识符',
      },
      exec_dir: {
        type: 'string',
        description: '执行命令的工作目录（必须使用绝对路径）',
      },
      command: {
        type: 'string',
        description: '要执行的 Shell 命令',
      },
    },
    required: ['session_id', 'exec_dir', 'command'],
  })
  async shellExecute(sessionId: string, execDir: string, command: string): Promise<ToolResult> {
    return this.sandbox.execCommand(sessionId, execDir, command);
  }

  @tool({
    name: 'shell_read_output',
    description: '查看指定 Shell 会话的内容。用于检查命令执行结果或监控输出。',
    parameters: {
      session_id: {
        type: 'string',
        description: '目标 Shell 会话的唯一标识符',
      },
    },
    required: ['session_id'],
  })
  async shellReadOutput(sessionId: string): Promise<ToolResult> {
    return this.sandbox.readShellOutput(sessionId);
  }

  @tool({
    name: 'shell_wait_process',
    description: '等待指定 Shell 会话中正在运行的进程返回。在运行耗时较长的命令后使用。',
    parameters: {
      session_id: {
        type: 'string',
        description: '目标 Shell 会话的唯一标识符',
      },
      seconds: {
        type: 'integer',
        description: '可选参数, 等待时长（秒）',
      },
    },
    required: ['session_id'],
  })
  async shellWaitProcess(sessionId: string, seconds?: number): Promise<ToolResult> {
    return this.sandbox.waitProcess(sessionId, seconds);
  }

  @tool({
    name: 'shell_write_input',
    description: '向指定 Shell 会话中正在运行的进程写入输入。用于响应交互式命令提示符。',
    parameters: {
      session_id: {
        type: 'string',
        description: '目标 Shell 会话的唯一标识符',
      },
      input_text: {
        type: 'string',
        description: '要写入进程的输入内容',
      },
      press_enter: {
        type: 'boolean',
        description: '输入后是否按下回车键',
      },
    },
    required: ['session_id', 'input_text', 'press_enter'],
  })
  async shellWriteInput(
    sessionId: string,
    inputText: string,
    pressEnter: boolean,
  ): Promise<ToolResult> {
    return this.sandbox.writeShellInput(sessionId, inputText, pressEnter);
  }

  @tool({
    name: 'shell_kill_process',
    description: '在指定 Shell 会话中终止正在运行的进程。用于停止长时间运行的进程或处理卡死的命令。',
    parameters: {
      session_id: {
        type: 'string',
        description: '目标 Shell 会话的唯一标识符',
      },
    },
    required: ['session_id'],
  })
  async shellKillProcess(sessionId: string): Promise<ToolResult> {
    return this.sandbox.killProcess(sessionId);
  }
}
