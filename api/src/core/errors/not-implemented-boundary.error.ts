import { ServerRequestsError } from './app-exception';

export class NotImplementedBoundaryError extends ServerRequestsError {
  constructor(boundaryName: string) {
    super(`${boundaryName} 在当前 Python 代码中尚未补齐，TS 侧仅保留边界`);
  }
}
