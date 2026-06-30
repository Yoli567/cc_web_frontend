export type MessageRole = 'user' | 'assistant'
export type ChatMode = 'message' | 'cabin'

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
}

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
}

export interface ImageBlock {
  type: 'image'
  url: string
  name?: string
  variant?: 'image' | 'sticker'
  sourcePath?: string
  width?: number
  height?: number
}

export interface AudioBlock {
  type: 'audio'
  url: string
  duration: number
  transcript?: string
}

export interface DocumentBlock {
  type: 'document'
  url: string
  name: string
  size: number
  mimeType?: string
}

export type ContentBlock =
  | ThinkingBlock
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | AudioBlock
  | DocumentBlock

export interface ChatMessage {
  id: string
  role: MessageRole
  content: ContentBlock[]
  timestamp: number
  isStreaming?: boolean
  sendStatus?: 'sending' | 'delivered' | 'read' | 'retry'
  turnId?: string
  replyTo?: ReplyTarget
  /** Inline system notice (connection state changes). Not persisted, not sent. */
  notice?: ConnectionNoticeType
}

export type ConnectionNoticeType = 'disconnected' | 'reconnected'

export interface ReplyTarget {
  messageId: string
  role: MessageRole
  text: string
  timestamp?: number
}

export interface Session {
  id: string
  name: string
  /** Last interface used for this session — drives default routing from the sidebar. */
  lastMode?: ChatMode
  /** Model id this session was last used with. */
  modelId?: string
  createdAt: number
  lastMessageAt: number
  /** Current token count in the session. */
  contextLength?: number
  /** Maximum context window (depends on the model). Defaults to 200_000. */
  contextLimit?: number
}

export interface ActivityToolRecord {
  id: string
  name: string
  input: Record<string, unknown>
  timestamp: number
  result?: string
  resultTimestamp?: number
}

export interface ActivityReplyRecord {
  id: string
  text: string
  timestamp: number
}

export interface ActivityEntry {
  id: string
  turnId: string
  sessionId: string | null
  source?: 'nudge' | 'self_alarm' | 'diary'
  timestamp: number
  dateKey: string
  title: string
  prompt: string
  thinking: string[]
  replies: ActivityReplyRecord[]
  tools: ActivityToolRecord[]
  completedAt?: number
}
