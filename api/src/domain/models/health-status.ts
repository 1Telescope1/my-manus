export type HealthStatus = {
  service: string;
  status: 'ok' | 'error' | string;
  details?: string;
};
