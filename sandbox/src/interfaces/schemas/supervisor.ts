import { ApiPropertyOptional } from '@nestjs/swagger';

/** 激活超时销毁请求。 */
export class TimeoutRequest {
  /** 分钟数。 */
  @ApiPropertyOptional({ description: '分钟数' })
  minutes?: number | null;
}