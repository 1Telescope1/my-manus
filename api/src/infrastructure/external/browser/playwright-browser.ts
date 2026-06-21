import {
  chromium,
  type Browser as PlaywrightBrowserInstance,
  type ElementHandle,
  type Page,
} from 'playwright';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { LLM } from '../../../domain/external/llm';
import { Browser as BrowserPort } from '../../../domain/external/browser';
import { ToolResult } from '../../../domain/models/tool-result';
import {
  GET_INTERACTIVE_ELEMENTS_FUNC,
  GET_VISIBLE_CONTENT_FUNC,
  INJECT_CONSOLE_LOGS_FUNC,
} from './playwright-browser.functions';

type InteractiveElement = {
  index: number;
  tag: string;
  text: string;
  selector: string;
};

type BrowserElementHandle = ElementHandle<SVGElement | HTMLElement>;

/**
 * Playwright 浏览器适配器。
 *
 * 只实现 infrastructure 层能力：通过 CDP 连接已有 Chromium，
 * 并按 domain Browser 协议暴露导航、查看页面、点击、输入、滚动、截图和 console 操作。
 */
export class PlaywrightBrowser extends BrowserPort {
  private browser: PlaywrightBrowserInstance | null = null;
  private page: Page | null = null;
  private interactiveElementsCache: InteractiveElement[] = [];

  constructor(
    private readonly cdpUrl: string,
    private readonly llm?: LLM,
  ) {
    super();
  }

  /** 确保浏览器和默认页面可用；缺失时按 Python 逻辑懒初始化。 */
  private async ensureBrowser(): Promise<void> {
    if (!this.browser || !this.page) {
      const initialized = await this.initialize();
      if (!initialized) {
        throw new Error('Failed to initialize Playwright browser');
      }
    }
  }

  /** 确保当前 page 指向浏览器上下文中的最新页面。 */
  private async ensurePage(): Promise<void> {
    await this.ensureBrowser();

    if (!this.browser) {
      throw new Error('Playwright browser is unavailable');
    }

    if (!this.page) {
      this.page = await this.browser.newPage();
      return;
    }

    const contexts = this.browser.contexts();
    if (!contexts.length) {
      return;
    }

    const pages = contexts[0].pages();
    if (!pages.length) {
      return;
    }

    const latestPage = pages[pages.length - 1];
    if (this.page !== latestPage) {
      this.page = latestPage;
    }
  }

  private getCurrentPage(): Page {
    if (!this.page) {
      throw new Error('Playwright page is unavailable');
    }
    return this.page;
  }

  /** 提取可见 HTML，并用 node-html-markdown 转成 Markdown。 */
  private async extractContent(): Promise<string> {
    const page = this.getCurrentPage();
    const visibleContent = (await page.evaluate(GET_VISIBLE_CONTENT_FUNC)) as string;
    const markdownContent = NodeHtmlMarkdown.translate(visibleContent);
    const maxContentLength = Math.min(markdownContent.length, 50_000);

    if (!this.llm) {
      return markdownContent.slice(0, maxContentLength);
    }

    const response = await this.llm.invoke({
      messages: [
        {
          role: 'system',
          content:
            'You are a professional webpage information extraction assistant. Extract all information from the current page content and convert it to markdown.',
        },
        {
          role: 'user',
          content: markdownContent.slice(0, maxContentLength),
        },
      ],
    });

    return typeof response.content === 'string' ? response.content : '';
  }

  /** 提取当前视口内可交互元素，并刷新 index 到 DOM 选择器的缓存。 */
  private async extractInteractiveElements(): Promise<string[]> {
    await this.ensurePage();
    const page = this.getCurrentPage();

    this.interactiveElementsCache = [];
    const interactiveElements = (await page.evaluate(
      GET_INTERACTIVE_ELEMENTS_FUNC,
    )) as InteractiveElement[];
    this.interactiveElementsCache = interactiveElements;

    return interactiveElements.map((element) => {
      return `${element.index}:<${element.tag}>${element.text}</${element.tag}>`;
    });
  }

  private async getElementById(index: number): Promise<BrowserElementHandle | null> {
    if (
      !this.interactiveElementsCache.length ||
      index >= this.interactiveElementsCache.length
    ) {
      return null;
    }

    const page = this.getCurrentPage();
    return page.$(`[data-manus-id="manus-element-${index}"]`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /** 初始化 CDP 连接；失败时按 Python 版本最多重试 5 次。 */
  async initialize(): Promise<boolean> {
    const maxRetries = 5;
    let retryInterval = 1_000;

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      try {
        this.browser = await chromium.connectOverCDP(this.cdpUrl);
        const contexts = this.browser.contexts();

        if (contexts.length && contexts[0].pages().length === 1) {
          const page = contexts[0].pages()[0];
          if (
            page.url() === 'about:blank' ||
            page.url() === 'chrome://newtab/' ||
            page.url() === 'chrome://new-tab-page/' ||
            !page.url()
          ) {
            this.page = page;
          } else {
            this.page = await contexts[0].newPage();
          }
        } else {
          const context = contexts[0] ?? (await this.browser.newContext());
          this.page = await context.newPage();
        }

        return true;
      } catch (error) {
        await this.cleanup();

        if (attempt === maxRetries - 1) {
          const err = error instanceof Error ? error : new Error(String(error));
          console.error(
            `Failed to initialize Playwright browser after ${maxRetries} retries: ${err.message}`,
          );
          return false;
        }

        const err = error instanceof Error ? error : new Error(String(error));
        console.warn(
          `Failed to initialize Playwright browser, retry ${attempt + 1}: ${err.message}`,
        );
        retryInterval = Math.min(retryInterval * 2, 10_000);
        await this.sleep(retryInterval);
      }
    }

    return false;
  }

  /** 关闭页面和浏览器连接，并清空本地缓存状态。 */
  async cleanup(): Promise<void> {
    try {
      if (this.browser) {
        for (const context of this.browser.contexts()) {
          for (const page of context.pages()) {
            if (!page.isClosed()) {
              await page.close();
            }
          }
        }
      }

      if (this.page && !this.page.isClosed()) {
        await this.page.close();
      }

      if (this.browser) {
        await this.browser.close();
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`Failed to clean up Playwright browser resources: ${err.message}`);
    } finally {
      this.page = null;
      this.browser = null;
      this.interactiveElementsCache = [];
    }
  }

  /** 等待 document.readyState 变为 complete。 */
  async waitForPageLoad(timeout = 15): Promise<boolean> {
    await this.ensurePage();
    const page = this.getCurrentPage();
    const startTime = Date.now();
    const checkInterval = 5_000;

    while (Date.now() - startTime < timeout * 1_000) {
      const isCompleted = (await page.evaluate(
        "() => document.readyState === 'complete'",
      )) as boolean;
      if (isCompleted) {
        return true;
      }

      await this.sleep(checkInterval);
    }

    return false;
  }

  async navigate(url: string): Promise<ToolResult> {
    await this.ensurePage();
    const page = this.getCurrentPage();

    try {
      this.interactiveElementsCache = [];
      await page.goto(url);
      return {
        success: true,
        data: {
          interactive_elements: await this.extractInteractiveElements(),
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        message: `Browser failed to navigate to [${url}]: ${err.message}`,
      };
    }
  }

  async viewPage(): Promise<ToolResult> {
    await this.ensurePage();
    await this.waitForPageLoad();

    const interactiveElements = await this.extractInteractiveElements();

    return {
      success: true,
      data: {
        content: await this.extractContent(),
        interactive_elements: interactiveElements,
      },
    };
  }

  async click(
    index?: number,
    coordinateX?: number,
    coordinateY?: number,
  ): Promise<ToolResult> {
    await this.ensurePage();
    const page = this.getCurrentPage();

    if (coordinateX !== undefined && coordinateY !== undefined) {
      await page.mouse.click(coordinateX, coordinateY);
    } else if (index !== undefined) {
      try {
        const element = await this.getElementById(index);
        if (!element) {
          return {
            success: false,
            message: `Element index ${index} is invalid or was not found`,
          };
        }

        const isVisible = (await page.evaluate((target) => {
          if (!target) return false;
          const rect = target.getBoundingClientRect();
          const style = window.getComputedStyle(target);
          return !(
            rect.width === 0 ||
            rect.height === 0 ||
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.opacity === '0'
          );
        }, element)) as boolean;

        if (!isVisible) {
          await page.evaluate((target) => {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, element);
          await this.sleep(1_000);
        }

        await element.click({ timeout: 5_000 });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return {
          success: false,
          message: `Failed to click element: ${err.message}`,
        };
      }
    }

    return { success: true };
  }

  async input(
    text: string,
    pressEnter: boolean,
    index?: number,
    coordinateX?: number,
    coordinateY?: number,
  ): Promise<ToolResult> {
    await this.ensurePage();
    const page = this.getCurrentPage();

    if (coordinateX !== undefined && coordinateY !== undefined) {
      await page.mouse.click(coordinateX, coordinateY);
      await page.keyboard.type(text);
    } else if (index !== undefined) {
      try {
        const element = await this.getElementById(index);
        if (!element) {
          return {
            success: false,
            message: 'Failed to input text, element does not exist',
          };
        }

        try {
          await element.fill('');
          await element.type(text);
        } catch {
          await element.click();
          await element.type(text);
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return {
          success: false,
          message: `Failed to input text: ${err.message}`,
        };
      }
    }

    if (pressEnter) {
      await page.keyboard.press('Enter');
    }

    return { success: true };
  }

  async moveMouse(coordinateX: number, coordinateY: number): Promise<ToolResult> {
    await this.ensurePage();
    await this.getCurrentPage().mouse.move(coordinateX, coordinateY);
    return { success: true };
  }

  async pressKey(key: string): Promise<ToolResult> {
    await this.ensurePage();
    await this.getCurrentPage().keyboard.press(key);
    return { success: true };
  }

  async selectOption(index: number, option: number): Promise<ToolResult> {
    await this.ensurePage();

    try {
      const element = await this.getElementById(index);
      if (!element) {
        return {
          success: false,
          message: `Select element index [${index}] does not exist`,
        };
      }

      await element.selectOption({ index: option });
      return { success: true };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        message: `Failed to select option: ${err.message}`,
      };
    }
  }

  async restart(url: string): Promise<ToolResult> {
    await this.cleanup();
    return this.navigate(url);
  }

  async scrollUp(toTop?: boolean): Promise<ToolResult> {
    await this.ensurePage();
    const page = this.getCurrentPage();

    if (toTop) {
      await page.evaluate('window.scrollTo(0, 0)');
    } else {
      await page.evaluate('window.scrollBy(0, -window.innerHeight)');
    }

    return { success: true };
  }

  async scrollDown(toBottom?: boolean): Promise<ToolResult> {
    await this.ensurePage();
    const page = this.getCurrentPage();

    if (toBottom) {
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    } else {
      await page.evaluate('window.scrollBy(0, window.innerHeight)');
    }

    return { success: true };
  }

  async screenshot(fullPage?: boolean): Promise<Buffer> {
    await this.ensurePage();
    return this.getCurrentPage().screenshot({
      fullPage,
      type: 'png',
    });
  }

  async consoleExec(javascript: string): Promise<ToolResult> {
    await this.ensurePage();
    const page = this.getCurrentPage();

    try {
      await page.evaluate(INJECT_CONSOLE_LOGS_FUNC);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.warn(`Failed to inject window.console.logs: ${err.message}`);
    }

    const result = await page.evaluate(javascript);
    return {
      success: true,
      data: {
        result,
      },
    };
  }

  async consoleView(maxLines?: number): Promise<ToolResult> {
    await this.ensurePage();
    const page = this.getCurrentPage();
    const logs = (await page.evaluate(`() => {
      return window.console.logs || [];
    }`)) as string[];

    return {
      success: true,
      data: {
        logs: maxLines !== undefined ? logs.slice(-maxLines) : logs,
      },
    };
  }
}


