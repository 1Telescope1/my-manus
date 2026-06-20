import { MCPTransport } from '../../domain/models/app-config';

export type ListMCPServerItem = {
  server_name: string;
  enabled: boolean;
  transport: MCPTransport;
  tools: string[];
};

export type ListMCPServerResponse = {
  mcp_servers: ListMCPServerItem[];
};

export type SetMcpServerEnabledBody = {
  enabled: boolean;
};
