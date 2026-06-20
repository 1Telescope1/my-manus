import { randomUUID } from 'node:crypto';

export enum ExecutionStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export type Step = {
  id: string;
  description: string;
  status: ExecutionStatus;
  result?: string | null;
  error?: string | null;
  success: boolean;
  attachments: string[];
};

export type Plan = {
  id: string;
  title: string;
  goal: string;
  language: string;
  steps: Step[];
  message: string;
  status: ExecutionStatus;
  error?: string | null;
};

export function createStep(input: Partial<Step> = {}): Step {
  return {
    id: input.id ?? randomUUID(),
    description: input.description ?? '',
    status: input.status ?? ExecutionStatus.PENDING,
    result: input.result ?? null,
    error: input.error ?? null,
    success: input.success ?? false,
    attachments: input.attachments ?? [],
  };
}

export function createPlan(input: Partial<Plan> = {}): Plan {
  return {
    id: input.id ?? randomUUID(),
    title: input.title ?? '',
    goal: input.goal ?? '',
    language: input.language ?? '',
    steps: (input.steps ?? []).map((step) => createStep(step)),
    message: input.message ?? '',
    status: input.status ?? ExecutionStatus.PENDING,
    error: input.error ?? null,
  };
}

export function isStepDone(step: Step): boolean {
  return [ExecutionStatus.COMPLETED, ExecutionStatus.FAILED].includes(step.status);
}

export function isPlanDone(plan: Plan): boolean {
  return [ExecutionStatus.COMPLETED, ExecutionStatus.FAILED].includes(plan.status);
}

export function getNextStep(plan: Plan): Step | undefined {
  return plan.steps.find((step) => !isStepDone(step));
}
