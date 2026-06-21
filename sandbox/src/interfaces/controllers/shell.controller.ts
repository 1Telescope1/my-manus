import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { homedir } from 'node:os';
import { ShellExecuteRequest } from '../schemas/shell';
import { type ApiResponse, ResponseEnvelope } from '../schemas/base';
import { type ShellExecuteResult } from '../../models/shell';
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
}
