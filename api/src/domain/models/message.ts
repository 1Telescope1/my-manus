export type Message = {
  message: string;
  attachments: string[];
};

export type MessageInput = {
  message?: unknown;
  attachments?: unknown;
};

export function messageToText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value == null) {
    return '';
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function createMessage(input: MessageInput = {}): Message {
  return {
    message: messageToText(input.message),
    attachments: Array.isArray(input.attachments)
      ? input.attachments.filter((item): item is string => typeof item === 'string')
      : [],
  };
}
