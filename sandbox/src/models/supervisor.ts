/** 进程信息模型。 */
export type ProcessInfo = {
  /** 进程名字。 */
  name: string;
  /** 进程分组。 */
  group: string;
  /** 进程描述。 */
  description: string;
  /** 进程开始时间戳。 */
  start: number;
  /** 进程结束时间戳。 */
  stop: number;
  /** 当前时间戳。 */
  now: number;
  /** 状态代码。 */
  state: number;
  /** 状态名字。 */
  statename: string;
  /** Spawn错误。 */
  spawnerr: string;
  /** 退出状态。 */
  exitstatus: number;
  /** 日志文件。 */
  logfile: string;
  /** 标准输出日志文件。 */
  stdout_logfile: string;
  /** 标准错误日志文件。 */
  stderr_logfile: string;
  /** 进程id(Process ID)。 */
  pid: number;
};

/** Supervisor动作/执行结果。 */
export type SupervisorActionResult = {
  /** 执行状态。 */
  status: string;
  /** 执行结果。 */
  result?: unknown;
  /** 停止结果。 */
  stop_result?: unknown;
  /** 开始结果。 */
  start_result?: unknown;
  /** 关闭结果。 */
  shutdown_result?: unknown;
};

/** Supervisor超时销毁模型。 */
export type SupervisorTimeout = {
  /** 超时设置状态。 */
  status?: string | null;
  /** 超时销毁是否激活。 */
  active: boolean;
  /** 销毁时间。 */
  shutdown_time?: string | null;
  /** 超时时间，单位为分钟。 */
  timeout_minutes?: number | null;
  /** 超时剩余秒数。 */
  remaining_seconds?: number | null;
};