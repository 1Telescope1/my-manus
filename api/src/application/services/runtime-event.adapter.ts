import {
  baseEvent,
  Event,
  events,
  PlanEventStatus,
  StepEventStatus,
  ToolEvent,
  ToolEventStatus,
} from '../../domain/models/event';
import { ExecutionStatus, Plan, Step } from '../../domain/models/plan';
import { RuntimeEvent } from '../../domain/models/runtime-event';

/**
 * 将 Runtime Event 转换成现有 Session/SSE 流使用的领域事件。
 *
 * 每个适配器实例保存各 Run 的 sequence 水位；重复事件和比水位更旧的事件不会再次输出。
 */
export class RuntimeEventAdapter {
  private readonly lastSequenceByRun = new Map<string, number>();

  adapt(runtimeEvent: RuntimeEvent): Event | null {
    validateRuntimeEvent(runtimeEvent);

    const lastSequence = this.lastSequenceByRun.get(runtimeEvent.runId);
    if (lastSequence !== undefined && runtimeEvent.sequence <= lastSequence) {
      return null;
    }

    const event = attachRuntimeContext(toSessionEvent(runtimeEvent), runtimeEvent);
    this.lastSequenceByRun.set(runtimeEvent.runId, runtimeEvent.sequence);
    return event;
  }

  adaptAll(runtimeEvents: Iterable<RuntimeEvent>): Event[] {
    const events: Event[] = [];
    for (const runtimeEvent of runtimeEvents) {
      const event = this.adapt(runtimeEvent);
      if (event) {
        events.push(event);
      }
    }
    return events;
  }

  getLastSequence(runId: string): number | undefined {
    return this.lastSequenceByRun.get(runId);
  }

  reset(runId?: string): void {
    if (runId === undefined) {
      this.lastSequenceByRun.clear();
      return;
    }
    this.lastSequenceByRun.delete(runId);
  }
}

function toSessionEvent(runtimeEvent: RuntimeEvent): Event {
  switch (runtimeEvent.type) {
    case 'title.updated':
      return {
        ...baseEvent('title'),
        type: 'title',
        title: runtimeEvent.title,
      };
    case 'message.created':
      return events.message({
        role: runtimeEvent.role,
        message: runtimeEvent.message,
        attachments: runtimeEvent.attachments ?? [],
      });
    case 'plan.created':
      return events.plan(clonePlan(runtimeEvent.plan), PlanEventStatus.CREATED);
    case 'plan.updated':
      return events.plan(clonePlan(runtimeEvent.plan), PlanEventStatus.UPDATED);
    case 'plan.completed':
      return events.plan(
        clonePlan(runtimeEvent.plan, ExecutionStatus.COMPLETED),
        PlanEventStatus.COMPLETED,
      );
    case 'step.started':
      return events.step(
        cloneStep(runtimeEvent.step, ExecutionStatus.RUNNING),
        StepEventStatus.STARTED,
      );
    case 'step.completed':
      return events.step(
        cloneStep(runtimeEvent.step, ExecutionStatus.COMPLETED),
        StepEventStatus.COMPLETED,
      );
    case 'step.failed':
      return events.step(
        cloneStep(runtimeEvent.step, ExecutionStatus.FAILED),
        StepEventStatus.FAILED,
      );
    case 'tool.calling':
    case 'tool.called':
      return events.tool({
        tool_call_id: runtimeEvent.toolCallId,
        tool_name: runtimeEvent.toolName,
        function_name: runtimeEvent.functionName,
        function_args: runtimeEvent.arguments,
        function_result: runtimeEvent.result,
        tool_content: runtimeEvent.content as ToolEvent['tool_content'],
        status: runtimeEvent.type === 'tool.calling'
          ? ToolEventStatus.CALLING
          : ToolEventStatus.CALLED,
      });
    case 'run.waiting':
      return events.wait();
    case 'run.failed':
      return events.error(runtimeEvent.error);
    case 'run.completed':
    case 'run.cancelled':
      return events.done();
    default:
      return assertNever(runtimeEvent);
  }
}

function attachRuntimeContext(event: Event, runtimeEvent: RuntimeEvent): Event {
  event.id = runtimeEvent.id;
  event.created_at = new Date(runtimeEvent.createdAt);
  event.run_id = runtimeEvent.runId;
  event.sequence = runtimeEvent.sequence;

  if (runtimeEvent.checkpointId !== undefined) {
    event.checkpoint_id = runtimeEvent.checkpointId;
  }

  const metadata = runtimeEvent.type === 'run.cancelled'
    ? { ...runtimeEvent.metadata, terminal_status: 'cancelled' }
    : runtimeEvent.metadata === undefined
      ? undefined
      : { ...runtimeEvent.metadata };
  if (metadata !== undefined) {
    event.metadata = metadata;
  }

  return event;
}

function clonePlan(plan: Plan, status = plan.status): Plan {
  return {
    ...plan,
    status,
    steps: plan.steps.map((step) => cloneStep(step)),
  };
}

function cloneStep(step: Step, status = step.status): Step {
  return {
    ...step,
    status,
    attachments: [...step.attachments],
  };
}

function validateRuntimeEvent(event: RuntimeEvent): void {
  if (!event.id.trim()) {
    throw new TypeError('Runtime Event id 不能为空');
  }
  if (!event.runId.trim()) {
    throw new TypeError('Runtime Event runId 不能为空');
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) {
    throw new RangeError('Runtime Event sequence 必须是非负安全整数');
  }
  if (!(event.createdAt instanceof Date) || !Number.isFinite(event.createdAt.getTime())) {
    throw new TypeError('Runtime Event createdAt 必须是有效日期');
  }
}

function assertNever(value: never): never {
  throw new TypeError(`不支持的 Runtime Event: ${JSON.stringify(value)}`);
}
