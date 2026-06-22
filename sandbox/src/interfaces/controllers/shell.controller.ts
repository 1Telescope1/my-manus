import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { homedir } from 'node:os';
import { BadRequestException } from '../errors/exceptions';
import {
  ShellExecuteRequest,
  ShellKillRequest,
  ShellReadRequest,
  ShellWaitRequest,
  ShellWriteRequest,
} from '../schemas/shell';
import { type ApiResponse, ResponseEnvelope } from '../schemas/base';
import {
  type ShellExecuteResult,
  type ShellKillResult,
  type ShellReadResult,
  type ShellWaitResult,
  type ShellWriteResult,
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

  /** 向指定会话的子进程写入数据。 */
  @Post('write-shell-input')
  async writeShellInput(
    @Body() request: ShellWriteRequest,
  ): Promise<ApiResponse<ShellWriteResult>> {
    if (!request.session_id || request.session_id === '') {
      throw new BadRequestException('Shell会话ID为空, 请核实后重试');
    }

    const result = await this.shellService.writeShellInput(
      request.session_id,
      request.input_text,
      request.press_enter ?? true,
    );

    return ResponseEnvelope.success(result, '向进程写入数据成功');
  }

  /** 终止指定会话的子进程。 */
  @Post('kill-process')
  async killProcess(
    @Body() request: ShellKillRequest,
  ): Promise<ApiResponse<ShellKillResult>> {
    if (!request.session_id || request.session_id === '') {
      throw new BadRequestException('Shell会话ID为空, 请核实后重试');
    }

    const result = await this.shellService.killProcess(request.session_id);
    const message = result.status === 'terminated' ? '进程终止' : '进程已结束';

    return ResponseEnvelope.success(result, message);
  }
}
