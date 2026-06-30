import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { ChatMessage, ThinkingBlock, ToolUseBlock, ToolResultBlock, ImageBlock, AudioBlock, DocumentBlock } from '@/types'
import { useMockCabin } from '@/hooks/useMockCabin'
import { useLiveCabin } from '@/hooks/useLiveCabin'
import { useStreamText } from '@/hooks/useStreamText'
import { useTheme } from '@/theme/ThemeContext'
import { useAppLayout } from '@/components/layout/AppLayout'
import { SidebarOpenIcon } from '@/components/layout/BottomNav'
import ThinkingSheet from '@/components/chat/ThinkingSheet'
import ChatComposer from '@/components/chat/ChatComposer'
import type { OutgoingPayload } from '@/components/chat/ChatComposer'
import MessageSearchPanel, { SearchIcon } from '@/components/chat/MessageSearchPanel'
import VoiceBubble from '@/components/chat/VoiceBubble'
import ImageBubble from '@/components/chat/ImageBubble'
import DocumentBubble from '@/components/chat/DocumentBubble'
import MarkdownContent from '@/components/chat/MarkdownContent'
import ConnectionNotice from '@/components/chat/ConnectionNotice'
import ScrollToBottomButton from '@/components/chat/ScrollToBottomButton'
import { voiceCacheKey } from '@/utils/voiceCache'
import { stripUserstyleBlock } from '@/utils/displayText'
import { formatTimestamp } from '@/utils/formatTime'
import { messagePlainText } from '@/utils/messageText'
import { isMessageSaved, loadSavedMessages, toggleSavedMessage } from '@/utils/savedMessages'
import { useSessions } from '@/sessions/SessionsContext'

const SCROLL_BUTTON_DISTANCE_PX = 220

export default function Cabin() {
  const { openSidebar } = useAppLayout()
  const { currentSessionId } = useSessions()
  const [searchParams] = useSearchParams()
  const mock = useMockCabin()
  const live = useLiveCabin()
  const { messages, isStreaming, sendMessage } = live.connected ? live : mock
  const resendMessage = live.connected ? live.resendMessage : undefined
  const { cabinBubble, cabinBackground } = useTheme()
  const [thinkingContent, setThinkingContent] = useState<string | null>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [savedMessages, setSavedMessages] = useState(() => loadSavedMessages())
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolledRef = useRef(false)
  const touchStartYRef = useRef<number | null>(null)

  const normalizedSearch = searchQuery.trim().toLowerCase()
  const searchMatches = useMemo(
    () => normalizedSearch
      ? messages.filter((message) => messagePlainText(message).toLowerCase().includes(normalizedSearch)).map((message) => message.id)
      : [],
    [messages, normalizedSearch],
  )
  const effectiveSearchIndex = searchMatches.length ? Math.min(searchIndex, searchMatches.length - 1) : 0
  const currentSearchId = searchMatches[effectiveSearchIndex] ?? null

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight
    const isNearBottom = () => distanceFromBottom() < 80
    const updateButton = () => setShowScrollButton(distanceFromBottom() > SCROLL_BUTTON_DISTANCE_PX)
    const onScroll = () => {
      if (isNearBottom()) userScrolledRef.current = false
      updateButton()
    }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 || !isNearBottom()) userScrolledRef.current = true
    }
    const onTouchStart = (event: TouchEvent) => {
      touchStartYRef.current = event.touches[0]?.clientY ?? null
    }
    const onTouchMove = (event: TouchEvent) => {
      const startY = touchStartYRef.current
      const currentY = event.touches[0]?.clientY
      if (startY !== null && currentY !== undefined && (currentY > startY || !isNearBottom())) {
        userScrolledRef.current = true
      }
    }
    const onPointerDown = () => {
      if (!isNearBottom()) userScrolledRef.current = true
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('pointerdown', onPointerDown, { passive: true })
    updateButton()
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('pointerdown', onPointerDown)
    }
  }, [])

  useEffect(() => {
    const onSavedChange = () => setSavedMessages(loadSavedMessages())
    window.addEventListener('cc-saved-messages-changed', onSavedChange)
    return () => window.removeEventListener('cc-saved-messages-changed', onSavedChange)
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && !userScrolledRef.current) {
      el.scrollTop = el.scrollHeight
      setShowScrollButton(false)
    } else if (el) {
      setShowScrollButton(el.scrollHeight - el.scrollTop - el.clientHeight > SCROLL_BUTTON_DISTANCE_PX)
    }
  }, [messages, isStreaming])

  useEffect(() => {
    if (!currentSearchId) return
    document.getElementById(cabinMessageDomId(currentSearchId))?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [currentSearchId])

  useEffect(() => {
    const focusId = searchParams.get('focus')
    if (!focusId || messages.length === 0) return
    window.setTimeout(() => {
      document.getElementById(cabinMessageDomId(focusId))?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 120)
  }, [messages.length, searchParams])

  const scrollToBottom = () => {
    const el = scrollRef.current
    if (!el) return
    userScrolledRef.current = false
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setShowScrollButton(false)
  }

  const stepSearch = (direction: 1 | -1) => {
    if (searchMatches.length === 0) return
    setSearchIndex((current) => (current + direction + searchMatches.length) % searchMatches.length)
  }

  const toggleSearch = () => {
    if (searchOpen) {
      setSearchOpen(false)
      setSearchQuery('')
      setSearchIndex(0)
      scrollToBottom()
      return
    }
    setSearchOpen(true)
  }

  const pageClass = cabinBackground
    ? 'cc-page flex h-full flex-col'
    : 'flex h-full flex-col bg-[var(--cc-bg)]'

  return (
    <div className={`${pageClass} relative overflow-x-hidden`}>
      <button
        type="button"
        onClick={openSidebar}
        aria-label="Open navigation"
        title="Navigation"
        className="cc-cabin-nav-button"
      >
        <SidebarOpenIcon />
      </button>
      <button
        type="button"
        onClick={toggleSearch}
        aria-label="Search cabin messages"
        title="Search"
        className="cc-cabin-search-button"
      >
        <SearchIcon />
      </button>
      {searchOpen && (
        <div className="cc-cabin-search-panel-wrap">
          <MessageSearchPanel
            query={searchQuery}
            onQueryChange={(value) => {
              setSearchQuery(value)
              setSearchIndex(0)
            }}
            count={searchMatches.length}
            current={effectiveSearchIndex}
            onPrevious={() => stepSearch(-1)}
            onNext={() => stepSearch(1)}
          />
        </div>
      )}
      <div ref={scrollRef} className="min-w-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto px-3.5 pb-40 pt-4">
        {messages.map((msg) => (
          <CabinBlock
            key={msg.id}
            message={msg}
            showBubble={cabinBubble}
            saved={isMessageSaved('cabin', currentSessionId, msg.id, savedMessages)}
            searchMatch={searchMatches.includes(msg.id)}
            activeSearchMatch={currentSearchId === msg.id}
            onToggleSaved={() => {
              setSavedMessages(toggleSavedMessage('cabin', currentSessionId, msg))
            }}
            onResend={resendMessage}
            onShowThinking={(t) => setThinkingContent(t)}
          />
        ))}
      </div>

      <CabinComposer sendMessage={sendMessage} />

      <ScrollToBottomButton visible={showScrollButton} onClick={scrollToBottom} />

      {thinkingContent && (
        <ThinkingSheet
          thinking={thinkingContent}
          onClose={() => setThinkingContent(null)}
        />
      )}
    </div>
  )
}

function CabinComposer({ sendMessage }: { sendMessage: (payload: OutgoingPayload) => void }) {
  const [input, setInput] = useState('')

  return (
    <ChatComposer
      mode="cabin"
      value={input}
      onChange={setInput}
      onSend={(payload) => {
        setInput('')
        sendMessage(payload)
      }}
      placeholder="Write something..."
      multiline
    />
  )
}

function CabinBlock({
  message,
  showBubble,
  saved,
  searchMatch,
  activeSearchMatch,
  onToggleSaved,
  onResend,
  onShowThinking,
}: {
  message: ChatMessage
  showBubble: boolean
  saved: boolean
  searchMatch: boolean
  activeSearchMatch: boolean
  onToggleSaved: () => void
  onResend?: (messageId: string) => void
  onShowThinking: (thinking: string) => void
}) {
  if (message.notice) {
    return <ConnectionNotice type={message.notice} timestamp={message.timestamp} />
  }

  const isUser = message.role === 'user'
  const textBlocks = message.content.filter((b) => b.type === 'text')
  const thinkingBlocks = message.content.filter((b): b is ThinkingBlock => b.type === 'thinking')
  const toolBlocks = message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
  const toolResultBlocks = message.content.filter((b): b is ToolResultBlock => b.type === 'tool_result')
  const imageBlocks = message.content.filter((b): b is ImageBlock => b.type === 'image')
  const audioBlocks = message.content.filter((b): b is AudioBlock => b.type === 'audio')
  const documentBlocks = message.content.filter((b): b is DocumentBlock => b.type === 'document')
  const fullText = textBlocks.map((b) => ('text' in b ? b.text : '')).join('\n')
  const displayText = isUser ? stripUserstyleBlock(fullText) : fullText
  const hasAssistantBody =
    fullText.trim().length > 0 ||
    toolBlocks.length > 0 ||
    toolResultBlocks.length > 0 ||
    imageBlocks.length > 0 ||
    audioBlocks.length > 0 ||
    documentBlocks.length > 0

  if (isUser) {
    const hasAnything =
      displayText.trim() ||
      imageBlocks.length > 0 ||
      audioBlocks.length > 0 ||
      documentBlocks.length > 0
    if (!hasAnything) return null

    return (
      <div id={cabinMessageDomId(message.id)} className={`cc-fade-in flex min-w-0 flex-col items-end gap-1.5 ${searchMatch ? 'cc-message-search-hit' : ''} ${activeSearchMatch ? 'cc-message-search-current' : ''}`}>
        {imageBlocks.map((block, i) => (
          <ImageBubble key={`img-${i}`} url={block.url} name={block.name} variant={block.variant} />
        ))}
        {documentBlocks.map((block, i) => (
          <DocumentBubble
            key={`doc-${i}`}
            url={block.url}
            name={block.name}
            size={block.size}
            mimeType={block.mimeType}
            isUser
          />
        ))}
        {audioBlocks.map((block, i) => (
          <VoiceBubble
            key={`audio-${i}`}
            cacheKey={voiceCacheKey(message.id, i)}
            url={block.url}
            duration={block.duration}
            transcript={block.transcript}
            isUser
          />
        ))}
        {displayText.trim() && (
          <div className="cc-user-bubble min-w-0 max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed text-white">
            <span className="cc-bubble-text block">{displayText}</span>
          </div>
        )}
        <p className="px-0.5 text-[10px] text-[var(--cc-dim)] text-right">
          {message.sendStatus && (
            <SendStatus status={message.sendStatus} onResend={onResend ? () => onResend(message.id) : undefined} />
          )}
          {formatTimestamp(message.timestamp)}
        </p>
      </div>
    )
  }

  if (!hasAssistantBody && !message.isStreaming) return null

  return (
    <div id={cabinMessageDomId(message.id)} className={`cc-fade-in min-w-0 ${searchMatch ? 'cc-message-search-hit' : ''} ${activeSearchMatch ? 'cc-message-search-current' : ''}`}>
      <div className="min-w-0 max-w-full">
        {thinkingBlocks.length > 0 && (
          <button
            onClick={() => onShowThinking(thinkingBlocks[0].thinking)}
            className="mb-[0.875rem] block w-full truncate text-left text-[12px] italic text-[var(--cc-primary)] opacity-70 transition-opacity hover:opacity-100"
          >
            {thinkingBlocks[0].thinking.slice(0, 100)}...
          </button>
        )}

        {(imageBlocks.length > 0 || documentBlocks.length > 0 || audioBlocks.length > 0) && (
          <div className="mb-1.5 flex flex-col items-start gap-1.5">
            {imageBlocks.map((block, i) => (
              <ImageBubble key={`img-${i}`} url={block.url} name={block.name} variant={block.variant} />
            ))}
            {documentBlocks.map((block, i) => (
              <DocumentBubble
                key={`doc-${i}`}
                url={block.url}
                name={block.name}
                size={block.size}
                mimeType={block.mimeType}
                isUser={false}
              />
            ))}
            {audioBlocks.map((block, i) => (
              <VoiceBubble
                key={`audio-${i}`}
                cacheKey={voiceCacheKey(message.id, i)}
                url={block.url}
                duration={block.duration}
                transcript={block.transcript}
                isUser={false}
              />
            ))}
          </div>
        )}

        {toolBlocks.length > 0 && toolBlocks.map((block) => (
          <ToolUseCollapsible
            key={block.id}
            block={block}
            result={toolResultBlocks.find((result) => result.tool_use_id === block.id)}
          />
        ))}

        {showBubble ? (
          hasAssistantBody || message.isStreaming ? (
            <div className="cc-cabin-bubble min-w-0 max-w-full rounded-2xl px-3.5 py-2.5">
              <StreamingText
                fullText={fullText}
                isStreaming={message.isStreaming ?? false}
              />
            </div>
          ) : null
        ) : (
          <StreamingText
            fullText={fullText}
            isStreaming={message.isStreaming ?? false}
          />
        )}

        {hasAssistantBody && !(message.isStreaming && !fullText) && (
          <p className="mt-1 flex items-center gap-1.5 px-0.5 text-[10px] text-[var(--cc-dim)] text-left">
            {formatTimestamp(message.timestamp)}
            <button
              type="button"
              onClick={onToggleSaved}
              aria-label={saved ? 'Unsave cabin message' : 'Save cabin message'}
              title={saved ? 'Saved' : 'Save'}
              className={`cc-bookmark-btn ${saved ? 'is-saved' : ''}`}
            >
              <BookmarkIcon filled={saved} />
            </button>
          </p>
        )}
      </div>
    </div>
  )
}

function cabinMessageDomId(messageId: string) {
  return `cabin-message-${messageId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

function BookmarkIcon({ filled }: { filled: boolean }) {
  return (
    <svg className="h-3.5 w-3.5" fill={filled ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 4.75A1.75 1.75 0 0 1 7.75 3h8.5A1.75 1.75 0 0 1 18 4.75V21l-6-3.5L6 21V4.75Z" />
    </svg>
  )
}

function SendStatus({
  status,
  onResend,
}: {
  status: NonNullable<ChatMessage['sendStatus']>
  onResend?: () => void
}) {
  if (status === 'retry') {
    return (
      <button
        type="button"
        onClick={onResend}
        disabled={!onResend}
        className="mr-[3px] text-[var(--cc-primary)] underline-offset-2 hover:underline disabled:text-[var(--cc-dim)] disabled:no-underline"
      >
        重新发送
      </button>
    )
  }
  const label = status === 'read' ? '已读' : status === 'delivered' ? '已送达' : '发送中'
  return <span className="mr-[3px]">{label}</span>
}

function StreamingText({ fullText, isStreaming }: { fullText: string; isStreaming: boolean }) {
  const { displayed } = useStreamText(fullText, isStreaming)

  if (!displayed && isStreaming) {
    return (
      <div className="cc-bubble-text text-sm leading-[1.58] text-[var(--cc-text)]">
        <span className="inline-block h-4 w-0.5 animate-[cc-cursor-blink_1s_step-end_infinite] bg-[var(--cc-primary)] align-text-bottom" />
      </div>
    )
  }

  return (
    <div className="cc-bubble-text text-sm">
      <MarkdownContent text={displayed} isStreaming={isStreaming} />
    </div>
  )
}

function ToolUseCollapsible({ block, result }: { block: ToolUseBlock; result?: ToolResultBlock }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="mb-1.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[12px] text-[var(--cc-dim)] transition-colors hover:text-[var(--cc-sub)]"
      >
        <span className="text-[10px]">{open ? '▾' : '▸'}</span>
        <span className="font-mono">{block.name}</span>
      </button>
      {open && (
        <div className="cc-tool-use-panel mt-1.5 max-h-40 overflow-y-auto p-3 font-mono text-xs text-[var(--cc-sub)]">
          <pre className="whitespace-pre-wrap">{JSON.stringify(block.input, null, 2)}</pre>
          {result?.content && (
            <pre className="mt-2 whitespace-pre-wrap opacity-75">{result.content}</pre>
          )}
        </div>
      )}
    </div>
  )
}
