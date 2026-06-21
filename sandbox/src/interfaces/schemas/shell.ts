import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** 执行命令请求结构体。 */
export class ShellExecuteRequest {
  @ApiPropertyOptional({ description: '目标 Shell 会话的唯一标识符' })
  session_id?: string;

  @ApiPropertyOptional({ description: '执行命令的工作目录，建议使用绝对路径' })
  exec_dir?: string;

  @ApiProperty({ description: '要执行的 Shell 命令' })
  command!: string;
}

/** 查看 Shell 执行内容请求结构体。 */
export class ShellReadRequest {
  @ApiProperty({ description: '目标 Shell 会话的唯一标识符' })
  session_id!: string;

  @ApiPropertyOptional({ description: '是否返回控制台记录列表' })
  console?: boolean;
}

/** 等待 Shell 命令执行请求结构体。 */
export class ShellWaitRequest {
  @ApiProperty({ description: '目标 Shell 会话的唯一标识符' })
  session_id!: string;

  @ApiPropertyOptional({ description: '等待时间，单位为秒' })
  seconds?: number;
}

/** 写入数据到子进程请求结构体。 */
export class ShellWriteRequest {
  @ApiProperty({ description: '目标 Shell 会话的唯一标识符' })
  session_id!: string;

  @ApiProperty({ description: '需要写入的内容文本' })
  input_text!: string;

  @ApiPropertyOptional({ default: true, description: '是否追加回车换行' })
  press_enter = true;
}

/** 关闭进程请求结构体。 */
export class ShellKillRequest {
  @ApiProperty({ description: '目标 Shell 会话的唯一标识符' })
  session_id!: string;
}

