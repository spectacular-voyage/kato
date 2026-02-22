export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  model?: string;
  toolCalls?: ToolCall[];
  thinkingBlocks?: ThinkingBlock[];
}

export interface ToolCall {
  id: string;
  name: string;
  description?: string;
  input?: Record<string, unknown>;
  result?: string;
}

export interface ThinkingBlock {
  content: string;
}
