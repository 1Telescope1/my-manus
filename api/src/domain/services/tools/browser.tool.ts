import { Browser } from '../../external/browser';
import { ToolResult } from '../../models/tool-result';
import { BaseTool, tool } from './base-tool';

export class BrowserTool extends BaseTool {
  readonly name = 'browser';

  constructor(private readonly browser: Browser) {
    super();
  }

  @tool({
    name: 'browser_view',
    description: '查看当前浏览器页面内容，用于确认已打开页面的最新状态。',
    parameters: {},
    required: [],
  })
  async browserView(): Promise<ToolResult> {
    return this.browser.viewPage();
  }

  @tool({
    name: 'browser_navigate',
    description: '将浏览器导航到指定网址，当需要访问新页面时使用。',
    parameters: {
      url: {
        type: 'string',
        description: '要访问的完整 URL，必须包含协议前缀，例如 https://。',
      },
    },
    required: ['url'],
  })
  async browserNavigate(url: string): Promise<ToolResult> {
    return this.browser.navigate(url);
  }

  @tool({
    name: 'browser_restart',
    description: '重新启动浏览器并导航到指定 URL，当需要重置浏览器状态时使用。',
    parameters: {
      url: {
        type: 'string',
        description: '要访问的完整 URL，必须包含协议前缀，例如 https://。',
      },
    },
    required: ['url'],
  })
  async browserRestart(url: string): Promise<ToolResult> {
    return this.browser.restart(url);
  }

  @tool({
    name: 'browser_click',
    description: '点击当前页面中的元素。可通过元素索引或页面坐标定位。',
    parameters: {
      index: {
        type: 'integer',
        description: '可选。需要点击的元素索引。',
      },
      coordinate_x: {
        type: 'number',
        description: '可选。点击位置的 x 坐标。',
      },
      coordinate_y: {
        type: 'number',
        description: '可选。点击位置的 y 坐标。',
      },
    },
    required: [],
  })
  async browserClick(
    index?: number,
    coordinateX?: number,
    coordinateY?: number,
  ): Promise<ToolResult> {
    return this.browser.click(index, coordinateX, coordinateY);
  }

  @tool({
    name: 'browser_input',
    description: '覆盖当前页面可编辑区域的文本，例如 input 或 textarea。',
    parameters: {
      text: {
        type: 'string',
        description: '要填入输入框的完整文本内容。',
      },
      press_enter: {
        type: 'boolean',
        description: '输入后是否按下回车键。',
      },
      index: {
        type: 'integer',
        description: '可选。需要填充文本的元素索引。',
      },
      coordinate_x: {
        type: 'number',
        description: '可选。需要填充文本元素的 x 坐标。',
      },
      coordinate_y: {
        type: 'number',
        description: '可选。需要填充文本元素的 y 坐标。',
      },
    },
    required: ['text', 'press_enter'],
  })
  async browserInput(
    text: string,
    pressEnter: boolean,
    index?: number,
    coordinateX?: number,
    coordinateY?: number,
  ): Promise<ToolResult> {
    return this.browser.input(text, pressEnter, index, coordinateX, coordinateY);
  }

  @tool({
    name: 'browser_move_mouse',
    description: '将鼠标光标移动到当前浏览器页面的指定位置。',
    parameters: {
      coordinate_x: {
        type: 'number',
        description: '目标光标位置的 x 坐标。',
      },
      coordinate_y: {
        type: 'number',
        description: '目标光标位置的 y 坐标。',
      },
    },
    required: ['coordinate_x', 'coordinate_y'],
  })
  async browserMoveMouse(coordinateX: number, coordinateY: number): Promise<ToolResult> {
    return this.browser.moveMouse(coordinateX, coordinateY);
  }

  @tool({
    name: 'browser_press_key',
    description: '在当前浏览器页面模拟按键，当需要执行键盘操作时使用。',
    parameters: {
      key: {
        type: 'string',
        description: '要模拟的按键名称，例如 Enter、Tab、ArrowUp，也支持组合键。',
      },
    },
    required: ['key'],
  })
  async browserPressKey(key: string): Promise<ToolResult> {
    return this.browser.pressKey(key);
  }

  @tool({
    name: 'browser_select_option',
    description: '从当前页面的下拉列表元素中选择指定选项。',
    parameters: {
      index: {
        type: 'integer',
        description: '需要操作的下拉列表元素索引。',
      },
      option: {
        type: 'integer',
        description: '要选择的选项序号，从 0 开始。',
      },
    },
    required: ['index', 'option'],
  })
  async browserSelectOption(index: number, option: number): Promise<ToolResult> {
    return this.browser.selectOption(index, option);
  }

  @tool({
    name: 'browser_scroll_up',
    description: '向上滚动浏览器页面，用于查看上方内容或回到页面顶部。',
    parameters: {
      to_top: {
        type: 'boolean',
        description: '可选。是否直接滚动到页面顶部，而不是向上滚动一屏。',
      },
    },
    required: [],
  })
  async browserScrollUp(toTop?: boolean): Promise<ToolResult> {
    return this.browser.scrollUp(toTop);
  }

  @tool({
    name: 'browser_scroll_down',
    description: '向下滚动浏览器页面，用于查看下方内容或跳转到页面底部。',
    parameters: {
      to_bottom: {
        type: 'boolean',
        description: '可选。是否直接滚动到页面底部，而不是向下滚动一屏。',
      },
    },
    required: [],
  })
  async browserScrollDown(toBottom?: boolean): Promise<ToolResult> {
    return this.browser.scrollDown(toBottom);
  }

  @tool({
    name: 'browser_console_exec',
    description: '在浏览器控制台中执行 JavaScript 代码。',
    parameters: {
      javascript: {
        type: 'string',
        description: '要执行的 JavaScript 代码。',
      },
    },
    required: ['javascript'],
  })
  async browserConsoleExec(javascript: string): Promise<ToolResult> {
    return this.browser.consoleExec(javascript);
  }

  @tool({
    name: 'browser_console_view',
    description: '查看浏览器控制台输出，用于检查 JavaScript 日志或调试页面错误。',
    parameters: {
      max_lines: {
        type: 'integer',
        description: '可选。返回的最大日志行数。',
      },
    },
    required: [],
  })
  async browserConsoleView(maxLines?: number): Promise<ToolResult> {
    return this.browser.consoleView(maxLines);
  }
}
