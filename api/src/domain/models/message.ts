export type Message = {
  message: string;
  attachments: string[];
};

export function createMessage(input: Partial<Message> = {}): Message {
  return {
    message: input.message ?? '',
    attachments: input.attachments ?? [],
  };
}
