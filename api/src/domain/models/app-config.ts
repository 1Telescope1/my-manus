import { z } from 'zod';

export enum MCPTransport {
  STDIO = 'stdio',
  SSE = 'sse',
  STREAMABLE_HTTP = 'streamable_http',
}

export const LLMConfigSchema = z.object({
  base_url: z.string().url().default('https://api.deepseek.com'),
  api_key: z.string().default(''),
  model_name: z.string().default('deepseek-reasoner'),
  temperature: z.number().default(0.7),
  max_tokens: z.number().int().nonnegative().default(8192),
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;

export const AgentConfigSchema = z.object({
  max_iterations: z.number().int().gt(0).lt(1000).default(100),
  max_retries: z.number().int().gt(1).lt(10).default(3),
  max_search_results: z.number().int().gt(1).lt(30).default(10),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const MCPServerConfigSchema = z
  .object({
    transport: z.nativeEnum(MCPTransport).default(MCPTransport.STREAMABLE_HTTP),
    enabled: z.boolean().default(true),
    description: z.string().nullable().optional(),
    env: z.record(z.unknown()).nullable().optional(),
    command: z.string().nullable().optional(),
    args: z.array(z.string()).nullable().optional(),
    url: z.string().nullable().optional(),
    headers: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (
      [MCPTransport.SSE, MCPTransport.STREAMABLE_HTTP].includes(value.transport) &&
      !value.url
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '在sse或streamable_http模式下必须传递url',
        path: ['url'],
      });
    }

    if (value.transport === MCPTransport.STDIO && !value.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '在stdio模式下必须传递command',
        path: ['command'],
      });
    }
  });

export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

export const MCPConfigSchema = z
  .object({
    mcpServers: z.record(MCPServerConfigSchema).default({}),
  })
  .passthrough();

export type MCPConfig = z.infer<typeof MCPConfigSchema>;

export const AppConfigSchema = z.object({
  llm_config: LLMConfigSchema,
  agent_config: AgentConfigSchema,
  mcp_config: MCPConfigSchema,
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export function createDefaultAppConfig(): AppConfig {
  return {
    llm_config: LLMConfigSchema.parse({}),
    agent_config: AgentConfigSchema.parse({}),
    mcp_config: MCPConfigSchema.parse({}),
  };
}
