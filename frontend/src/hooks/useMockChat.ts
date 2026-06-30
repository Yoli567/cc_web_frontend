import { useState, useCallback, useRef } from 'react'
import type { ChatMessage } from '@/types'
import { mockMessages } from '@/mock/mockData'
import { buildUserContent } from '@/utils/buildUserContent'
import type { OutgoingPayload } from '@/components/chat/ChatComposer'

const mockReplies: { thinking?: string; messages: string[] }[] = [
  {
    thinking: '用户在问编程的问题...让我想想怎么解释得更清楚一些。',
    messages: [
      '这是一个很好的问题，让我来解释一下。',
      '你可以这样理解。',
    ],
  },
  {
    thinking: '看起来用户想了解更多细节...我可以用一个例子来说明。',
    messages: [
      '你想了解哪个方面？',
      '我可以给你一个具体的代码示例。',
      '如果还有不清楚的地方可以继续问我。',
    ],
  },
  {
    messages: [
      '嗯，让我想想。',
      '我觉得可以这样处理。',
    ],
  },
  {
    thinking: '这个问题挺有意思的，从另一个角度来看可能会更好理解。',
    messages: [
      '从另一个角度来看，这个问题其实可以拆解成几个小问题。',
      '这样分析的话就清楚多了。',
    ],
  },
  {
    messages: [
      '哈哈没问题',
      '有什么问题随时可以问我',
    ],
  },
]

let replyIndex = 0

export function useMockChat() {
  const [messages, setMessages] = useState<ChatMessage[]>(mockMessages)
  const [isTyping, setIsTyping] = useState(false)
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([])

  const clearTimeouts = useCallback(() => {
    timeoutsRef.current.forEach(clearTimeout)
    timeoutsRef.current = []
  }, [])

  const sendMessage = useCallback((payload: OutgoingPayload) => {
    const content = buildUserContent(payload)
    if (content.length === 0) return

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
      replyTo: payload.replyTo,
    }

    setMessages((prev) => [...prev, userMsg])

    const reply = mockReplies[replyIndex % mockReplies.length]
    replyIndex++

    clearTimeouts()

    const t1 = setTimeout(() => {
      setIsTyping(true)
    }, 600 + Math.random() * 800)
    timeoutsRef.current.push(t1)

    let delay = 1800 + Math.random() * 1500
    reply.messages.forEach((msgText, i) => {
      const t = setTimeout(() => {
        const assistantMsg: ChatMessage = {
          id: `assistant-${Date.now()}-${i}`,
          role: 'assistant',
          content: [
            ...(i === 0 && reply.thinking
              ? [{ type: 'thinking' as const, thinking: reply.thinking }]
              : []),
            { type: 'text' as const, text: msgText },
          ],
          timestamp: Date.now(),
        }

        setMessages((prev) => [...prev, assistantMsg])

        if (i === reply.messages.length - 1) {
          setIsTyping(false)
        }
      }, delay)

      timeoutsRef.current.push(t)
      delay += 800 + Math.random() * 1200
    })
  }, [clearTimeouts])

  const deleteMessages = useCallback((messageIds: string[]) => {
    const ids = new Set(messageIds)
    setMessages((prev) => prev.filter((message) => !ids.has(message.id)))
  }, [])

  return { messages, isTyping, sendMessage, deleteMessages }
}
