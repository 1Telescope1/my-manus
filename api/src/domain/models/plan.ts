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

export type StepInput = Partial<Step> | string;

export function createStep(input: StepInput = {}): Step {
  const normalized = typeof input === 'string'
    ? { description: input }
    : input;

  return {
    id: normalized.id ?? randomUUID(),
    description: normalized.description?.trim() ?? '',
    status: normalized.status ?? ExecutionStatus.PENDING,
    result: normalized.result ?? null,
    error: normalized.error ?? null,
    success: normalized.success ?? false,
    attachments: normalized.attachments ?? [],
  };
}

export type PlanInput = Omit<Partial<Plan>, 'steps'> & {
  steps?: StepInput[];
};

export function createPlan(input: PlanInput = {}): Plan {
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
