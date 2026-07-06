import { ToolResult } from '../../models/tool-result';
import { BaseTool, tool } from './base-tool';

export type UserTakeoverTarget = 'none' | 'browser';

export class MessageTool extends BaseTool {
  readonly name = 'message';

  /** 发送通知消息给用户，不需要用户响应。 */
  @tool({
    name: 'message_notify_user',
    description:
      '向用户发送消息，且无需用户回复。用于确认收到消息、提供进度更新、报告任务完成情况，或解释处理方式的变更。',
    parameters: {
      text: {
        type: 'string',
        description: '要显示给用户的消息文本',
      },
    },
    required: ['text'],
  })
  async messageNotifyUser(_text: string): Promise<ToolResult<string>> {
    return { success: true, data: 'Continue' };
  }

  /** 提问用户并等待响应。 */
  @tool({
    name: 'message_ask_user',
    description: '向用户提问并等待回复。用于：请求澄清、寻求确认、或收集额外信息。',
    parameters: {
      text: {
        type: 'string',
        description: '要展示给用户的问题文本',
      },
      attachments: {
        anyOf: [{ type: 'string' }, { items: { type: 'string' }, type: 'array' }],
        description: '(可选)与问题相关的文件或参考资料',
      },
      suggest_user_takeover: {
        type: 'string',
        enum: ['none', 'browser'],
        description: '(可选)建议用户接管的操作（例如由用户在浏览器中手动完成某些事）。',
      },
    },
    required: ['text'],
  })
  async messageAskUser(
    _text: string,
    _attachments?: string | string[],
    _suggestUserTakeover?: UserTakeoverTarget,
  ): Promise<ToolResult> {
    return { success: true };
  }
}
