import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

/** Supervisor 模块路由壳。 */
@ApiTags('Supervisor模块')
@Controller('supervisor')
export class SupervisorController {}

