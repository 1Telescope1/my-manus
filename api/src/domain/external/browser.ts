import { ToolResult } from '../models/tool-result';

export abstract class Browser {
  abstract viewPage(signal?: AbortSignal): Promise<ToolResult>;

  abstract navigate(url: string, signal?: AbortSignal): Promise<ToolResult>;

  abstract restart(url: string, signal?: AbortSignal): Promise<ToolResult>;

  abstract click(
    index?: number,
    coordinateX?: number,
    coordinateY?: number,
    signal?: AbortSignal,
  ): Promise<ToolResult>;

  abstract input(
    text: string,
    pressEnter: boolean,
    index?: number,
    coordinateX?: number,
    coordinateY?: number,
    signal?: AbortSignal,
  ): Promise<ToolResult>;

  abstract moveMouse(
    coordinateX: number,
    coordinateY: number,
    signal?: AbortSignal,
  ): Promise<ToolResult>;

  abstract pressKey(key: string, signal?: AbortSignal): Promise<ToolResult>;

  abstract selectOption(index: number, option: number, signal?: AbortSignal): Promise<ToolResult>;

  abstract scrollUp(toTop?: boolean, signal?: AbortSignal): Promise<ToolResult>;

  abstract scrollDown(toBottom?: boolean, signal?: AbortSignal): Promise<ToolResult>;

  abstract screenshot(fullPage?: boolean, signal?: AbortSignal): Promise<Buffer>;

  abstract consoleExec(javascript: string, signal?: AbortSignal): Promise<ToolResult>;

  abstract consoleView(maxLines?: number, signal?: AbortSignal): Promise<ToolResult>;
}
