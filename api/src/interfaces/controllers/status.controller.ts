import { Controller, Get } from '@nestjs/common';
import { StatusService } from '../../application/services/status.service';
import { ResponseEnvelope } from '../../core/response/api-response';

@Controller('status')
export class StatusController {
  constructor(private readonly statusService: StatusService) {}

  @Get()
  async getStatus() {
    const statuses = await this.statusService.checkAll();
    if (statuses.some((item) => item.status === 'error')) {
      return ResponseEnvelope.fail(503, '系统存在服务异常', statuses);
    }

    return ResponseEnvelope.success(statuses, '系统健康检查成功');
  }
}
