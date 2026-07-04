import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type ApiResponse, ResponseEnvelope } from '../schemas/base';
import { TimeoutRequest } from '../schemas/supervisor';
import {
  type ProcessInfo,
  type SupervisorActionResult,
  type SupervisorTimeout,
} from '../../models/supervisor';
import { SupervisorService } from '../../services/supervisor.service';

@ApiTags('Supervisor模块')
@Controller('supervisor')
export class SupervisorController {
  constructor(private readonly supervisorService: SupervisorService) {}

  /** 获取沙箱中所有进程服务的状态信息。 */
  @Get('status')
  async getStatus(): Promise<ApiResponse<ProcessInfo[]>> {
    // 状态接口直接透出 supervisor 管理的所有进程信息。
    const processes = await this.supervisorService.getAllProcesses();
    return ResponseEnvelope.success(processes, '获取沙箱进程服务成功');
  }

  /** 停止所有 supervisor 进程服务。 */
  @Post('stop-all-processes')
  async stopAllProcesses(): Promise<ApiResponse<SupervisorActionResult>> {
    // 停止所有子进程，但不关闭 supervisor 主进程。
    const result = await this.supervisorService.stopAllProcesses();
    return ResponseEnvelope.success(result, '停止Supervisor所有进程服务成功');
  }

  /** 关闭 supervisor 服务本身。 */
  @Post('shutdown')
  async shutdown(): Promise<ApiResponse<SupervisorActionResult>> {
    // 关闭 supervisor 主进程会触发沙箱服务整体退出。
    const result = await this.supervisorService.shutdown();
    return ResponseEnvelope.success(result, 'Supervisor服务关闭成功');
  }

  /** 重启 supervisor 管理的所有子进程。 */
  @Post('restart')
  async restart(): Promise<ApiResponse<SupervisorActionResult>> {
    // 重启时由服务层先停止全部子进程，再重新拉起。
    const result = await this.supervisorService.restart();
    return ResponseEnvelope.success(result, '重启Supervisor所有进程服务成功');
  }

  /** 传递分钟激活超时沙箱销毁设置，并关闭自动保活配置。 */
  @Post('activate-timeout')
  async activateTimeout(
    @Body() request: TimeoutRequest,
  ): Promise<ApiResponse<SupervisorTimeout>> {
    // 主动激活超时销毁后，自动保活需要关闭，避免后续请求继续延长。
    const result = await this.supervisorService.activateTimeout(request.minutes);
    this.supervisorService.disableExpand();
    return ResponseEnvelope.success(
      result,
      `超时销毁已设置, 所有服务与沙箱将在${result.timeout_minutes}分钟后销毁`,
    );
  }

  /** 传递指定的分钟延长超时时间并关闭自动保活。 */
  @Post('extend-timeout')
  async extendTimeout(
    @Body() request: TimeoutRequest,
  ): Promise<ApiResponse<SupervisorTimeout>> {
    // 手动延长超时也视为显式超时管理，因此关闭自动保活。
    const result = await this.supervisorService.extendTimeout(request.minutes);
    this.supervisorService.disableExpand();
    return ResponseEnvelope.success(
      result,
      `超时销毁时间已延长${request.minutes}分钟, 所有服务与沙箱将在${result.timeout_minutes}后销毁`,
    );
  }

  /** 取消超时销毁配置。 */
  @Post('cancel-timeout')
  async cancelTimeout(): Promise<ApiResponse<SupervisorTimeout>> {
    // 取消时根据当前状态返回不同文案，便于调用方区分是否真的取消了任务。
    const result = await this.supervisorService.cancelTimeout();
    const message = result.status === 'timeout_cancelled' ? '超时销毁已取消' : '超时销毁未激活';
    return ResponseEnvelope.success(result, message);
  }

  /** 获取当前 supervisor 的超时状态配置。 */
  @Get('timeout-status')
  async getTimeoutStatus(): Promise<ApiResponse<SupervisorTimeout>> {
    // 状态接口只查询当前超时配置，不修改自动保活或销毁定时器。
    const result = await this.supervisorService.getTimeoutStatus();
    const message = !result.active
      ? '未激活超时销毁'
      : `剩余超时销毁分钟数: ${Math.floor((result.remaining_seconds ?? 0) / 60)}`;
    return ResponseEnvelope.success(result, message);
  }
}
