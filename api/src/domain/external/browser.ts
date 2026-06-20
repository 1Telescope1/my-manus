import { ToolResult } from '../models/tool-result';

export abstract class Browser {
  abstract viewPage(): Promise<ToolResult>;

  abstract navigate(url: string): Promise<ToolResult>;

  abstract restart(url: string): Promise<ToolResult>;

  abstract click(index?: number, coordinateX?: number, coordinateY?: number): Promise<ToolResult>;

  abstract input(
    text: string,
    pressEnter: boolean,
    index?: number,
    coordinateX?: number,
    coordinateY?: number,
  ): Promise<ToolResult>;

  abstract moveMouse(coordinateX: number, coordinateY: number): Promise<ToolResult>;

  abstract pressKey(key: string): Promise<ToolResult>;

  abstract selectOption(index: number, option: number): Promise<ToolResult>;

  abstract scrollUp(toTop?: boolean): Promise<ToolResult>;

  abstract scrollDown(toBottom?: boolean): Promise<ToolResult>;

  abstract screenshot(fullPage?: boolean): Promise<Buffer>;

  abstract consoleExec(javascript: string): Promise<ToolResult>;

  abstract consoleView(maxLines?: number): Promise<ToolResult>;
}
