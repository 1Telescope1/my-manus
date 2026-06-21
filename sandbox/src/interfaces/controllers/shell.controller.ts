import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

/** Shell 模块路由壳；当前 Python 只定义 `/api/shell` 空 router。 */
@ApiTags('Shell模块')
@Controller('shell')
export class ShellController {}
