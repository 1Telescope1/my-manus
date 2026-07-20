/** Artifact 承载内容的业务类别。 */
export enum ArtifactKind {
  /** 用户上传或 Agent 生成的文件。 */
  FILE = 'file',
  /** 超过模型内联阈值的工具结果。 */
  TOOL_RESULT = 'tool_result',
  /** 浏览器或其他视觉工具生成的截图。 */
  SCREENSHOT = 'screenshot',
  /** 可单独读取的结构化数据。 */
  STRUCTURED_DATA = 'structured_data',
}

/** Session 生命周期内可按需读取的大内容元数据。 */
export type Artifact = {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string | null;
  readonly byteSize: number;
  readonly storageKey: string;
  readonly createdAt: Date;
};
