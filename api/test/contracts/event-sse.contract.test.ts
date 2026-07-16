import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DoneEvent,
  events,
  PlanEvent,
  PlanEventStatus,
  StepEvent,
  StepEventStatus,
  ToolEvent,
  ToolEventStatus,
  WaitEvent,
} from '../../src/domain/models/event';
import { createPlan, ExecutionStatus } from '../../src/domain/models/plan';
import { EventMapper } from '../../src/interfaces/dto/event.dto';

const CREATED_AT = new Date('2026-07-16T08:00:00.000Z');
const CREATED_AT_SECONDS = 1_784_188_800;

function withIdentity<T extends { id: string; created_at: Date }>(event: T, id: string): T {
  event.id = id;
  event.created_at = CREATED_AT;
  return event;
}

function wireValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

test('Plan SSE 事件应包含事件 ID、秒级时间戳和步骤列表', () => {
  const plan = createPlan({
    id: 'plan-1',
    title: '测试计划',
    goal: '验证事件格式',
    language: 'zh-CN',
    status: ExecutionStatus.RUNNING,
    steps: [{
      id: 'step-1',
      description: '执行测试步骤',
      status: ExecutionStatus.RUNNING,
    }],
  });
  const event = withIdentity(events.plan(plan, PlanEventStatus.UPDATED), 'event-plan') as PlanEvent;

  assert.deepEqual(wireValue(EventMapper.eventToSseEvent(event)), {
    event: 'plan',
    data: {
      event_id: 'event-plan',
      created_at: CREATED_AT_SECONDS,
      steps: [{
        event_id: 'event-plan',
        created_at: CREATED_AT_SECONDS,
        id: 'step-1',
        status: 'running',
        description: '执行测试步骤',
      }],
    },
  });
});

test('Step SSE 事件应包含步骤 ID、执行状态和步骤描述', () => {
  const step = createPlan({
    steps: [{
      id: 'step-1',
      description: '执行测试步骤',
      status: ExecutionStatus.COMPLETED,
      success: true,
    }],
  }).steps[0];
  const event = withIdentity(events.step(step, StepEventStatus.COMPLETED), 'event-step') as StepEvent;

  assert.deepEqual(wireValue(EventMapper.eventToSseEvent(event)), {
    event: 'step',
    data: {
      event_id: 'event-step',
      created_at: CREATED_AT_SECONDS,
      id: 'step-1',
      status: 'completed',
      description: '执行测试步骤',
    },
  });
});

test('Tool SSE 事件应保留调用 ID，并区分调用中和调用完成', () => {
  const calling = withIdentity(events.tool({
    tool_call_id: 'call-1',
    tool_name: 'search',
    function_name: 'search_web',
    function_args: { query: 'SSE 事件格式' },
    status: ToolEventStatus.CALLING,
  }), 'event-tool-calling') as ToolEvent;
  const called = withIdentity(events.tool({
    tool_call_id: 'call-1',
    tool_name: 'search',
    function_name: 'search_web',
    function_args: { query: 'SSE 事件格式' },
    function_result: { success: true },
    tool_content: { results: [] },
    status: ToolEventStatus.CALLED,
  }), 'event-tool-called') as ToolEvent;

  assert.deepEqual(wireValue(EventMapper.eventToSseEvent(calling)), {
    event: 'tool',
    data: {
      event_id: 'event-tool-calling',
      created_at: CREATED_AT_SECONDS,
      tool_call_id: 'call-1',
      name: 'search',
      status: 'calling',
      function: 'search_web',
      args: { query: 'SSE 事件格式' },
    },
  });
  assert.deepEqual(wireValue(EventMapper.eventToSseEvent(called)), {
    event: 'tool',
    data: {
      event_id: 'event-tool-called',
      created_at: CREATED_AT_SECONDS,
      tool_call_id: 'call-1',
      name: 'search',
      status: 'called',
      function: 'search_web',
      args: { query: 'SSE 事件格式' },
      content: { results: [] },
    },
  });
});

test('Wait 和 Done SSE 事件应包含事件 ID 和时间戳', () => {
  const wait = withIdentity(events.wait(), 'event-wait') as WaitEvent;
  const done = withIdentity(events.done(), 'event-done') as DoneEvent;

  assert.deepEqual(wireValue(EventMapper.eventToSseEvent(wait)), {
    event: 'wait',
    data: { event_id: 'event-wait', created_at: CREATED_AT_SECONDS },
  });
  assert.deepEqual(wireValue(EventMapper.eventToSseEvent(done)), {
    event: 'done',
    data: { event_id: 'event-done', created_at: CREATED_AT_SECONDS },
  });
});
