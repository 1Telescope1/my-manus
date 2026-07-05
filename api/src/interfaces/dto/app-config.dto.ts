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

export type ListA2AServerItem = {
  id: string;
  name: string;
  description: string;
  input_modes: string[];
  output_modes: string[];
  streaming: boolean;
  push_notifications: boolean;
  enabled: boolean;
};

export type ListA2AServerResponse = {
  a2a_servers: ListA2AServerItem[];
};

export type CreateA2AServerBody = {
  base_url: string;
};

export type SetA2AServerEnabledBody = {
  enabled: boolean;
};