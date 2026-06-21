import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

/** 文件模块路由壳。 */
@ApiTags('文件模块')
@Controller('file')
export class FileController {}

