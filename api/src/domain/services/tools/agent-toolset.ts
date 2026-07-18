import { Browser } from '../../external/browser';
import { Sandbox } from '../../external/sandbox';
import { SearchEngine } from '../../external/search-engine';
import { A2ATool } from './a2a.tool';
import { BaseTool } from './base-tool';
import { BrowserTool } from './browser.tool';
import { FileTool } from './file.tool';
import { MCPTool } from './mcp.tool';
import { MessageTool } from './message.tool';
import { SearchTool } from './search.tool';
import { ShellTool } from './shell.tool';
import { ToolRegistry } from '../../models/tool';
import { InMemoryToolRegistry } from './tool-registry';

/** 组装 Planner 与 Runtime 执行器共用的 Agent 工具集合。 */
export function createAgentToolset(input: {
  browser: Browser;
  sandbox: Sandbox;
  searchEngine: SearchEngine;
  mcpTool: MCPTool;
  a2aTool: A2ATool;
}): BaseTool[] {
  return [
    new FileTool(input.sandbox),
    new ShellTool(input.sandbox),
    new BrowserTool(input.browser),
    new SearchTool(input.searchEngine),
    new MessageTool(),
    input.mcpTool,
    input.a2aTool,
  ];
}

/** 从当前工具包快照创建 Registry，并在装配时立即暴露名称冲突。 */
export function createAgentToolRegistry(tools: readonly BaseTool[]): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();
  synchronizeAgentToolRegistry(registry, tools);
  return registry;
}

/** 把动态工具包中新出现的注册项增量同步到 Registry。 */
export function synchronizeAgentToolRegistry(
  registry: ToolRegistry,
  tools: readonly BaseTool[],
): void {
  const unseen = tools
    .flatMap((tool) => tool.getRegistrations())
    .filter((registration) => !registry.getById(registration.descriptor.id));
  registry.registerAll(unseen);
}
