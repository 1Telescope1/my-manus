import { ServerRequestsError } from './app-exception';

export class NotImplementedBoundaryError extends ServerRequestsError {
  constructor(boundaryName: string) {
    super(`${boundaryName} 在当前实现中尚未补齐，仅保留边界`);
  }
}

