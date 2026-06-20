import { HealthStatus } from '../models/health-status';

export abstract class HealthChecker {
  abstract check(): Promise<HealthStatus>;
}
