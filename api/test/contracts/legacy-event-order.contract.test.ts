import assert from 'node:assert/strict';
import test from 'node:test';
import { JSONParser } from '../../src/domain/external/json-parser';
import { Event, events, PlanEventStatus, StepEventStatus, ToolEventStatus } from '../../src/domain/models/event';
import { createMessage } from '../../src/domain/models/message';
import { createPlan, ExecutionStatus } from '../../src/domain/models/plan';
import { createSession, SessionStatus } from '../../src/domain/models/session';
import { UnitOfWork } from '../../src/domain/repositories/unit-of-work';
import { ReActAgent } from '../../src/domain/services/agents/react-agent';
import { PlannerReActFlow } from '../../src/domain/services/flows/planner-react-flow';

class ParseJson extends JSONParser {
  async invoke<T>(text: string, defaultValue?: T): Promise<T> {
    try {
      return JSON.parse(text) as T;
    } catch {
      return defaultValue as T;
    }
  }
}

class StubReActAgent extends ReActAgent {
  constructor(private readonly invocationEvents: Event[]) {
    super(
      () => ({} as UnitOfWork),
      'session-1',
      { max_iterations: 2, max_retries: 1, max_search_results: 5 },
      {} as never,
      new ParseJson(),
      [],
    );
  }

  override async *invoke(): AsyncGenerator<Event> {
    for (const event of this.invocationEvents) {
      yield event;
    }
  }
}

function descriptors(eventList: Event[]): string[] {
  return eventList.map((event) => {
    if (event.type === 'plan' || event.type === 'step' || event.type === 'tool') {
      return `${event.type}:${event.status}`;
    }
    return event.type;
  });
}

async function collect(generator: AsyncGenerator<Event>): Promise<Event[]> {
  const result: Event[] = [];
  for await (const event of generator) {
    result.push(event);
  }
  return result;
}

test('执行普通工具步骤时应依次发送步骤开始、工具调用和步骤完成事件', async () => {
  const agent = new StubReActAgent([
    events.tool({
      tool_call_id: 'call-1',
      tool_name: 'search',
      function_name: 'search_web',
      function_args: { query: '测试查询' },
      status: ToolEventStatus.CALLING,
    }),
    events.tool({
      tool_call_id: 'call-1',
      tool_name: 'search',
      function_name: 'search_web',
      function_args: { query: '测试查询' },
      function_result: { success: true },
      status: ToolEventStatus.CALLED,
    }),
    events.message({ message: JSON.stringify({ success: true, result: '执行完成' }) }),
  ]);
  const plan = createPlan({ language: 'zh-CN', steps: ['执行任务'] });

  const output = await collect(agent.executeStep(
    plan,
    plan.steps[0],
    createMessage({ message: '开始测试' }),
  ));

  assert.deepEqual(descriptors(output), [
    'step:started',
    'tool:calling',
    'tool:called',
    'step:completed',
    'message',
  ]);
  assert.equal(output[0].type === 'step' && output[0].step.status, ExecutionStatus.COMPLETED);
});

test('需要用户补充信息时应先发送提示消息，再进入等待状态', async () => {
  const agent = new StubReActAgent([
    events.tool({
      tool_call_id: 'call-ask',
      tool_name: 'message',
      function_name: 'message_ask_user',
      function_args: { text: '请选择一个选项' },
      status: ToolEventStatus.CALLING,
    }),
    events.tool({
      tool_call_id: 'call-ask',
      tool_name: 'message',
      function_name: 'message_ask_user',
      function_args: { text: '请选择一个选项' },
      function_result: { success: true },
      status: ToolEventStatus.CALLED,
    }),
  ]);
  const plan = createPlan({ language: 'zh-CN', steps: ['询问用户'] });

  const output = await collect(agent.executeStep(
    plan,
    plan.steps[0],
    createMessage({ message: '开始测试' }),
  ));

  assert.deepEqual(descriptors(output), ['step:started', 'message', 'wait']);
  assert.equal(output[1].type === 'message' && output[1].message, '请选择一个选项');
  assert.equal(plan.steps[0].status, ExecutionStatus.RUNNING);
});

test('计划正常完成时应依次发送已完成的 Plan 事件和 Done 事件', async () => {
  const session = createSession({ id: 'session-1', status: SessionStatus.PENDING });
  const statusUpdates: SessionStatus[] = [];
  const uow = {
    session: {
      getById: async () => session,
      updateStatus: async (_sessionId: string, status: SessionStatus) => {
        statusUpdates.push(status);
        session.status = status;
      },
    },
    run: async <T>(fn: (active: UnitOfWork) => Promise<T>) => fn(uow as unknown as UnitOfWork),
  } as unknown as UnitOfWork;
  const plan = createPlan({
    id: 'plan-1',
    title: '测试计划',
    message: '开始执行测试',
    language: 'zh-CN',
    steps: [{ id: 'step-1', description: '执行任务' }],
  });
  const planner = {
    async *createPlan(): AsyncGenerator<Event> {
      yield events.plan(plan, PlanEventStatus.CREATED);
    },
    async *updatePlan(): AsyncGenerator<Event> {
      yield events.plan(plan, PlanEventStatus.UPDATED);
    },
    async rollBack(): Promise<void> {},
  };
  const react = {
    async *executeStep(): AsyncGenerator<Event> {
      const step = plan.steps[0];
      step.status = ExecutionStatus.RUNNING;
      yield events.step(step, StepEventStatus.STARTED);
      yield events.tool({
        tool_call_id: 'call-1',
        tool_name: 'search',
        function_name: 'search_web',
        function_args: { query: '测试查询' },
        status: ToolEventStatus.CALLING,
      });
      yield events.tool({
        tool_call_id: 'call-1',
        tool_name: 'search',
        function_name: 'search_web',
        function_args: { query: '测试查询' },
        function_result: { success: true },
        status: ToolEventStatus.CALLED,
      });
      step.status = ExecutionStatus.COMPLETED;
      step.success = true;
      yield events.step(step, StepEventStatus.COMPLETED);
      yield events.message({ message: '步骤结果' });
    },
    async *summarize(): AsyncGenerator<Event> {
      yield events.message({ message: '最终结果' });
    },
    async compactMemory(): Promise<void> {},
    async rollBack(): Promise<void> {},
  };
  const flow = new PlannerReActFlow(
    () => uow,
    {} as never,
    { max_iterations: 2, max_retries: 1, max_search_results: 5 },
    'session-1',
    new ParseJson(),
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  Object.assign(flow, { planner, react });

  const output = await collect(flow.invoke(createMessage({ message: '开始测试' })));

  assert.deepEqual(descriptors(output), [
    'title',
    'message',
    'plan:created',
    'step:started',
    'tool:calling',
    'tool:called',
    'step:completed',
    'message',
    'plan:updated',
    'message',
    'plan:completed',
    'done',
  ]);
  assert.deepEqual(statusUpdates, [SessionStatus.RUNNING]);
  assert.equal(flow.done, true);
});
