import type { ChatMessage } from '@/types'

export const mockMessages: ChatMessage[] = [
  {
    id: '1',
    role: 'user',
    content: [{ type: 'text', text: '帮我看看这段代码，总是报错' }],
    timestamp: Date.now() - 3600000,
  },
  {
    id: '2',
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        thinking: '用户遇到了代码报错的问题...让我分析一下可能的原因。常见的情况有类型不匹配、缺少依赖、或者语法错误。',
      },
      { type: 'text', text: '好的，把代码发过来，我帮你看看是什么问题。' },
    ],
    timestamp: Date.now() - 3500000,
  },
  {
    id: '3',
    role: 'user',
    content: [{ type: 'text', text: '改了一天 bug，头都大了😭' }],
    timestamp: Date.now() - 3400000,
  },
  {
    id: '4',
    role: 'assistant',
    content: [
      { type: 'text', text: '调了一整天确实辛苦。先休息一下，有时候换个角度就能找到问题。' },
    ],
    timestamp: Date.now() - 3300000,
  },
  {
    id: '5',
    role: 'user',
    content: [{ type: 'text', text: '好吧，先不想了' }],
    timestamp: Date.now() - 3200000,
  },
  {
    id: '6',
    role: 'assistant',
    content: [
      { type: 'text', text: '好的，休息一下再回来看，效率会更高。有问题随时找我。' },
    ],
    timestamp: Date.now() - 3100000,
  },
]

export const mockCabinMessages: ChatMessage[] = [
  {
    id: 'c1',
    role: 'user',
    content: [{ type: 'text', text: '今天天气真好，想出去走走' }],
    timestamp: Date.now() - 7200000,
  },
  {
    id: 'c2',
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        thinking: '用户想出去走走...天气好的时候出去散步确实很舒服。可以聊一些轻松的话题。',
      },
      {
        type: 'tool_use',
        id: 'tool_1',
        name: 'user_time',
        input: {},
      },
      {
        type: 'text',
        text: '天气好的时候出去走走确实很棒！阳光和新鲜空气总能让人心情愉悦。\n\n你有什么特别想去的地方吗？公园、河边、还是就在附近随便转转？\n\n有时候最好的散步就是没有目的地的，走到哪算哪，发现一些平时忽略的小细节。',
      },
    ],
    timestamp: Date.now() - 7100000,
  },
]

export const mockSessions = [
  {
    id: 'session-1',
    name: '日常聊天',
    mode: 'message' as const,
    createdAt: Date.now() - 86400000,
    lastMessageAt: Date.now() - 3100000,
    contextLength: 12480,
  },
  {
    id: 'session-2',
    name: '技术讨论',
    mode: 'cabin' as const,
    createdAt: Date.now() - 86400000 * 2,
    lastMessageAt: Date.now() - 7100000,
    contextLength: 28960,
  },
]
