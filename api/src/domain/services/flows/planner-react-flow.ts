import { Logger } from '@nestjs/common';
import { Browser } from '../../external/browser';
import { JSONParser } from '../../external/json-parser';
import { LLM } from '../../external/llm';
import { Sandbox } from '../../external/sandbox';
import { SearchEngine } from '../../external/search-engine';
import { AgentConfig } from '../../models/app-config';
import { baseEvent, Event, events, PlanEventStatus } from '../../models/event';
import { Message } from '../../models/message';
import { ExecutionStatus, getNextStep, Plan, Step } from '../../models/plan';
import { getLatestPlan, SessionStatus } from '../../models/session';
import { UnitOfWork } from '../../repositories/unit-of-work';
import { PlannerAgent } from '../agents/planner-agent';
import { ReActAgent } from '../agents/react-agent';
import { A2ATool } from '../tools/a2a.tool';
import { BrowserTool } from '../tools/browser.tool';
import { FileTool } from '../tools/file.tool';
import { MCPTool } from '../tools/mcp.tool';
import { MessageTool } from '../tools/message.tool';
import { SearchTool } from '../tools/search.tool';
import { ShellTool } from '../tools/shell.tool';
import { BaseFlow, FlowStatus } from './base-flow';

export class PlannerReActFlow extends BaseFlow {
  private readonly logger = new Logger(PlannerReActFlow.name);
  private readonly planner: PlannerAgent;
  private readonly react: ReActAgent;
  private status = FlowStatus.IDLE;
  private plan?: Plan;

  constructor(
    private readonly uowFactory: () => UnitOfWork,
    private readonly llm: LLM,
    private readonly agentConfig: AgentConfig,
    private readonly sessionId: string,
    private readonly jsonParser: JSONParser,
    private readonly browser: Browser,
    private readonly sandbox: Sandbox,
    private readonly searchEngine: SearchEngine,
    private readonly mcpTool: MCPTool,
    private readonly a2aTool: A2ATool,
  ) {
    super();

    // 1. 初始化 Agent 预设工具列表。
    const tools = [
      new FileTool(this.sandbox),
      new ShellTool(this.sandbox),
      new BrowserTool(this.browser),
      new SearchTool(this.searchEngine),
      new MessageTool(),
      this.mcpTool,
      this.a2aTool,
    ];

    // 2. 创建规划 Agent。
    this.planner = new PlannerAgent(
      this.uowFactory,
      this.sessionId,
      this.agentConfig,
      this.llm,
      this.jsonParser,
      tools,
    );
    this.logger.debug(`创建规划Agent成功, 会话id: ${this.sessionId}`);

    // 3. 创建执行 Agent。
    this.react = new ReActAgent(
      this.uowFactory,
      this.sessionId,
      this.agentConfig,
      this.llm,
      this.jsonParser,
      tools,
    );
    this.logger.debug(`创建执行Agent成功, 会话id: ${this.sessionId}`);
  }

  /** 传递消息，运行规划与执行流，并持续返回对应事件。 */
  async *invoke(message: Message): AsyncGenerator<Event> {
    // 1. 调用会话仓库查询会话是否存在。
    const session = await this.withUow((uow) => uow.session.getById(this.sessionId));
    if (!session) {
      throw new Error(`会话[${this.sessionId}]不存在, 请核实后尝试`);
    }

    // 2. 判断会话的状态是不是空闲。
    // 如果不是，则需要处理历史消息列表，避免工具调用消息后直接接上用户消息。
    if (session.status !== SessionStatus.PENDING) {
      this.logger.debug(`会话[${this.sessionId}]未处于空闲状态，回滚数据确保消息列表格式正确`);
      await this.planner.rollBack(message);
      await this.react.rollBack(message);
    }

    // 3. 如果会话状态等于运行中，则流需要重新规划内容。
    if (session.status === SessionStatus.RUNNING) {
      this.logger.debug(`会话[${this.sessionId}]处于运行状态并传递了新消息`);
      this.status = FlowStatus.PLANNING;
    }

    // 4. 如果会话状态等于等待用户输入，则需要修改流的状态为执行中。
    if (session.status === SessionStatus.WAITING) {
      this.logger.debug(`会话[${this.sessionId}]处于等待状态并传递了新消息`);
      this.status = FlowStatus.EXECUTING;
    }

    // 5. 更新会话状态为运行中。
    await this.withUow((uow) => uow.session.updateStatus(this.sessionId, SessionStatus.RUNNING));

    // 6. 获取当前会话中最新计划。
    this.plan = getLatestPlan(session);
    this.logger.log(`Planner&ReAct流接收消息: ${message.message.slice(0, 50)}...`);

    // 7. 定义当前正在执行的子步骤。
    let step: Step | undefined;

    // 8. 创建循环执行任务，根据流的不同状态执行不同的操作。
    while (true) {
      if (this.status === FlowStatus.IDLE) {
        // 9. 如果流的状态为空闲，则只需要将状态修改为规划中。
        this.logger.log(`Planner&ReAct流状态从${FlowStatus.IDLE}变成${FlowStatus.PLANNING}`);
        this.status = FlowStatus.PLANNING;
      } else if (this.status === FlowStatus.PLANNING) {
        // 10. 流状态为规划中，则调用规划 Agent。
        this.logger.log('Planner&ReAct流开始创建计划/Plan');
        for await (const event of this.planner.createPlan(message)) {
          // 11. 判断规划 Agent 是否返回规划事件。
          if (event.type === 'plan' && event.status === PlanEventStatus.CREATED) {
            // 12. 创建计划成功时需要更新计划。
            this.plan = event.plan;
            this.logger.log(`Planner&ReAct流成功创建计划, 共计: ${event.plan.steps.length} 步`);

            // 13. 在计划中同步生成了会话标题和初始 AI 消息。
            yield { ...baseEvent('title'), type: 'title', title: event.plan.title };
            yield events.message({ role: 'assistant', message: event.plan.message });
          }

          // 14. 将生成的事件直接输出。
          yield event;
        }

        // 15. 计划创建完成，更新流状态为执行中。
        this.logger.log(`Planner&ReAct流状态从${FlowStatus.PLANNING}变成${FlowStatus.EXECUTING}`);
        this.status = FlowStatus.EXECUTING;

        // 16. 判断计划是否生成，步骤是否正常。
        if (!this.plan || this.plan.steps.length === 0) {
          this.logger.log('Planner&ReAct流创建计划失败或无子步骤');
          this.status = FlowStatus.COMPLETED;
        }
      } else if (this.status === FlowStatus.EXECUTING) {
        // 17. 流的状态为执行中，先将计划状态调整为运行中。
        this.plan!.status = ExecutionStatus.RUNNING;

        // 18. 获取当前计划的下一个需要执行的子步骤。
        step = getNextStep(this.plan!);

        // 19. 如果不存在下一个需要执行的子步骤，则更新流状态并执行后续步骤。
        if (!step) {
          this.logger.log(`Planner&ReAct流状态从${FlowStatus.EXECUTING}变成${FlowStatus.SUMMARIZING}`);
          this.status = FlowStatus.SUMMARIZING;
          continue;
        }

        // 20. 调用执行 Agent 执行对应的步骤。
        this.logger.log(`Planner&ReAct流开始执行步骤 ${step.id}: ${step.description.slice(0, 50)}...`);
        for await (const event of this.react.executeStep(this.plan!, step, message)) {
          yield event;
        }

        // 21. 压缩执行 Agent 记忆，避免上下文腐化和消耗大量 token。
        this.logger.log(`压缩${this.react.name} Agent记忆/上下文`);
        await this.react.compactMemory();

        // 22. 将状态更新为 updating。
        this.status = FlowStatus.UPDATING;
      } else if (this.status === FlowStatus.UPDATING) {
        // 23. 流状态为更新，表示需要更新计划。
        this.logger.log('Planner&ReAct流开始更新计划');
        for await (const event of this.planner.updatePlan(this.plan!, step!)) {
          yield event;
        }

        // 24. 计划更新完成，需要执行相应的子步骤。
        this.logger.log(`Planner&ReAct流状态从${FlowStatus.UPDATING}变成${FlowStatus.EXECUTING}`);
        this.status = FlowStatus.EXECUTING;
      } else if (this.status === FlowStatus.SUMMARIZING) {
        // 25. 流状态为总结中，则意味着所有子步骤都执行完成。
        this.logger.log('Planner&ReAct流开始总结');
        for await (const event of this.react.summarize()) {
          yield event;
        }

        // 26. 总结完毕，意味着流即将结束。
        this.logger.log(`Planner&ReAct流状态从${FlowStatus.SUMMARIZING}变成${FlowStatus.COMPLETED}`);
        this.status = FlowStatus.COMPLETED;
      } else if (this.status === FlowStatus.COMPLETED) {
        // 27. 计划状态已完成则更新 plan 状态，并发送计划事件通知 API 已完成。
        this.plan!.status = ExecutionStatus.COMPLETED;
        this.status = FlowStatus.IDLE;
        yield events.plan(this.plan!, PlanEventStatus.COMPLETED);
        break;
      }
    }

    // 28. 任务已经结束则返回结束事件。
    yield events.done();
    this.logger.log('Planner&ReAct流处理任务消息已完毕');
  }

  /** 只读属性，返回流是否运行结束。 */
  get done(): boolean {
    return this.status === FlowStatus.IDLE;
  }

  private async withUow<T>(handler: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    const uow = this.uowFactory();
    return uow.run(handler);
  }
}
