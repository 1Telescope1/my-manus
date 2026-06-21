import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

/** Supervisor 模块路由壳；当前 Python 只定义 `/api/supervisor` 空 router。 */
@ApiTags('Supervisor模块')
@Controller('supervisor')
export class SupervisorController {}
