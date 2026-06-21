import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { homedir } from 'node:os';
import { BadRequestException } from '../errors/exceptions';
import { ShellExecuteRequest, ShellReadRequest, ShellWaitRequest } from '../schemas/shell';
import { type ApiResponse, ResponseEnvelope } from '../schemas/base';
import {
  type ShellExecuteResult,
  type ShellReadResult,
  type ShellWaitResult,
} from '../../models/shell';
import { ShellService } from '../../services/shell.service';

@ApiTags('Shell模块')
@Controller('shell')
export class ShellController {
  constructor(private readonly shellService: ShellService) {}

  /** 在指定的 Shell 会话中运行命令。 */
  @Post('exec-command')
  async execCommand(
    @Body() request: ShellExecuteRequest,
  ): Promise<ApiResponse<ShellExecuteResult>> {
    if (!request.session_id || request.session_id === '') {
      request.session_id = this.shellService.createSessionId();
    }

    if (!request.exec_dir || request.exec_dir === '') {
      request.exec_dir = homedir();
    }

    const result = await this.shellService.execCommand(
      request.session_id,
      request.exec_dir,
      request.command,
    );

    return ResponseEnvelope.success(result);
  }

  /** 根据会话 ID 读取命令输出。 */
  @Post('read-shell-output')
  async readShellOutput(
    @Body() request: ShellReadRequest,
  ): Promise<ApiResponse<ShellReadResult>> {
    if (!request.session_id || request.session_id === '') {
      throw new BadRequestException('Shell会话ID为空, 请核实后重试');
    }

    const result = await this.shellService.readShellOutput(request.session_id, request.console);

    return ResponseEnvelope.success(result);
  }

  /** 等待指定会话中的进程结束。 */
  @Post('wait-process')
  async waitProcess(
    @Body() request: ShellWaitRequest,
  ): Promise<ApiResponse<ShellWaitResult>> {
    if (!request.session_id || request.session_id === '') {
      throw new BadRequestException('Shell会话ID为空, 请核实后重试');
    }

    const result = await this.shellService.waitProcess(request.session_id, request.seconds);

    return ResponseEnvelope.success(
      result,
      `进程结束, 返回状态码(returncode): ${result.returncode}`,
    );
  }
}
