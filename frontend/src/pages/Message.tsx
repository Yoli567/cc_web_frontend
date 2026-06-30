import { useState, useRef, useEffect, useLayoutEffect, useMemo, type ChangeEvent, type MouseEvent as ReactMouseEvent, type PointerEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { ChatMessage, ImageBlock, AudioBlock, DocumentBlock, ToolResultBlock, ToolUseBlock, ReplyTarget } from '@/types'
import { useMockChat } from '@/hooks/useMockChat'
import { useLiveChat } from '@/hooks/useLiveChat'
import { useAppLayout } from '@/components/layout/AppLayout'
import { SidebarOpenIcon } from '@/components/layout/BottomNav'
import ThinkingSheet from '@/components/chat/ThinkingSheet'
import ChatComposer from '@/components/chat/ChatComposer'
import MessageSearchPanel, { SearchIcon } from '@/components/chat/MessageSearchPanel'
import VoiceBubble from '@/components/chat/VoiceBubble'
import ImageBubble from '@/components/chat/ImageBubble'
import DocumentBubble from '@/components/chat/DocumentBubble'
import ConnectionNotice from '@/components/chat/ConnectionNotice'
import ScrollToBottomButton from '@/components/chat/ScrollToBottomButton'
import { stripUserstyleBlock } from '@/utils/displayText'
import { formatTimestamp } from '@/utils/formatTime'
import { messagePlainText, messagePreview } from '@/utils/messageText'
import { isMessageSaved, loadSavedMessages, saveMessageSnapshot, toggleSavedMessage } from '@/utils/savedMessages'
import { voiceCacheKey } from '@/utils/voiceCache'
import { syncClaudeAvatarForNotifications } from '@/utils/pwaNotifications'
import { useSessions } from '@/sessions/SessionsContext'

const GROUP_TIME_WINDOW_MS = 5 * 60 * 1000
const AVATAR_STORAGE_KEY = 'cc-claude-avatar'
const SCROLL_BUTTON_DISTANCE_PX = 220

export default function Message() {
  const { openSidebar } = useAppLayout()
  const { currentSessionId } = useSessions()
  const [searchParams] = useSearchParams()
  const mock = useMockChat()
  const live = useLiveChat()
  const { messages, isTyping, sendMessage, deleteMessages } = live.connected ? live : mock
  const resendMessage = live.connected ? live.resendMessage : undefined
  const [input, setInput] = useState('')
  const [thinkingContent, setThinkingContent] = useState<string | null>(null)
  const [avatar, setAvatar] = useState(() => localStorage.getItem(AVATAR_STORAGE_KEY) ?? '')
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [actionMenu, setActionMenu] = useState<{ message: ChatMessage; x: number; y: number } | null>(null)
  const [savedMessages, setSavedMessages] = useState(() => loadSavedMessages())
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const userScrolledRef = useRef(false)
  const touchStartYRef = useRef<number | null>(null)
  const longPressTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)

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

  useEffect(() => {
    void syncClaudeAvatarForNotifications(avatar)
  }, [avatar])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && !userScrolledRef.current) {
      el.scrollTop = el.scrollHeight
      setShowScrollButton(false)
    } else if (el) {
      setShowScrollButton(el.scrollHeight - el.scrollTop - el.clientHeight > SCROLL_BUTTON_DISTANCE_PX)
    }
  }, [messages, isTyping])

  // Images/voice/documents finish loading after the initial bottom-scroll and
  // grow the content, leaving the view stranded a few messages above the real
  // bottom. Re-pin to bottom whenever the content grows, unless user scrolled up.
  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!userScrolledRef.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!currentSearchId) return
    document.getElementById(messageDomId(currentSearchId))?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [currentSearchId])

  useEffect(() => {
    const focusId = searchParams.get('focus')
    if (!focusId || messages.length === 0) return
    // Jumping to a specific message: opt out of bottom auto-pin so the
    // ResizeObserver doesn't yank the view back down.
    userScrolledRef.current = true
    window.setTimeout(() => {
      document.getElementById(messageDomId(focusId))?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 120)
  }, [messages.length, searchParams])

  const scrollToBottom = () => {
    const el = scrollRef.current
    if (!el) return
    userScrolledRef.current = false
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setShowScrollButton(false)
  }

  const handleAvatarUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !file.type.startsWith('image/')) return

    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      setAvatar(result)
      localStorage.setItem(AVATAR_STORAGE_KEY, result)
    }
    reader.readAsDataURL(file)
  }

  const openActionMenu = (message: ChatMessage, x: number, y: number) => {
    setActionMenu({ message, x: Math.min(x, window.innerWidth - 172), y: Math.min(y, window.innerHeight - 190) })
  }

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }

  const handleMessagePointerDown = (message: ChatMessage, event: PointerEvent) => {
    clearLongPressTimer()
    if (selectedIds.size > 0) return
    longPressTimerRef.current = window.setTimeout(() => openActionMenu(message, event.clientX, event.clientY), 460)
  }

  const toggleSelection = (messageId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(messageId)) next.delete(messageId)
      else next.add(messageId)
      return next
    })
  }

  const saveMessages = (ids: string[]) => {
    messages
      .filter((message) => ids.includes(message.id))
      .forEach((message) => saveMessageSnapshot('message', currentSessionId, message))
    setSavedMessages(loadSavedMessages())
    setSelectedIds(new Set())
  }

  const deleteSelectedMessages = (ids: string[]) => {
    deleteMessages(ids)
    setSelectedIds(new Set())
    setActionMenu(null)
  }

  const copyMessage = (message: ChatMessage) => {
    const text = messagePlainText(message)
    if (!text.trim()) return
    void writeClipboardText(text)
    setActionMenu(null)
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

  const scrollToMessage = (messageId: string) => {
    document.getElementById(messageDomId(messageId))?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  const resolveReplyTargetId = (currentMessage: ChatMessage) => {
    const reply = currentMessage.replyTo
    if (!reply) return null
    if (messages.some((message) => message.id === reply.messageId)) return reply.messageId
    // reply_message (MCP) quotes are plain text with a synthetic messageId, so
    // fall back to matching the quoted text against an earlier message.
    const quote = normalizeForMatch(reply.text)
    if (quote.length < 2) return null
    const currentIndex = messages.findIndex((message) => message.id === currentMessage.id)
    const upperBound = currentIndex === -1 ? messages.length : currentIndex
    // Search nearest-first so we land on the message the reply most likely targets.
    for (let i = upperBound - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role !== reply.role) continue
      const plain = normalizeForMatch(messagePlainText(message))
      if (!plain) continue
      if (plain === quote) return message.id
      const shorter = plain.length <= quote.length ? plain : quote
      const longer = plain.length <= quote.length ? quote : plain
      // Require a substantial overlap so short messages ("嗯", "好") never
      // false-match a long quote and jerk the view to the top of the page.
      if (shorter.length >= 6 && longer.includes(shorter)) return message.id
    }
    return null
  }

  return (
    <div className="cc-page relative flex h-full flex-col overflow-x-hidden">
      <header className="cc-header flex items-center gap-2 px-3 py-3">
        <button
          type="button"
          onClick={openSidebar}
          aria-label="Open navigation"
          title="Navigation"
          className="cc-header-nav-button"
        >
          <SidebarOpenIcon />
        </button>
        <button
          type="button"
          onClick={() => avatarInputRef.current?.click()}
          aria-label="Upload Claude avatar"
          title="Upload avatar"
          className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--cc-primary)]"
        >
          {avatar ? (
            <img src={avatar} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="text-sm font-bold text-white">C</span>
          )}
        </button>
        <input
          ref={avatarInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleAvatarUpload}
        />
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold text-[var(--cc-text)]">Claude</h1>
          <p className="text-[11px] text-[var(--cc-primary)] opacity-75">
            {isTyping ? 'typing...' : live.connected ? 'online' : 'offline (mock)'}
          </p>
        </div>
        <button
          type="button"
          onClick={toggleSearch}
          aria-label="Search messages"
          title="Search"
          className="cc-header-nav-button ml-auto"
        >
          <SearchIcon />
        </button>
      </header>

      {searchOpen && (
        <div className="cc-message-search-panel-wrap">
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

      <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3.5 pb-36 pt-2.5">
        <div ref={contentRef} className="min-w-0">
        {messages.map((msg, index) => {
          const previous = messages[index - 1]
          const next = messages[index + 1]
          const joinsPrevious = isSameMessageGroup(previous, msg)
          const joinsNext = isSameMessageGroup(msg, next)
          const startsGroup = !joinsPrevious
          const endsGroup = !joinsNext

          return (
            <MessageBubble
              key={msg.id}
              message={msg}
              previousRole={previous?.role}
              startsGroup={startsGroup}
              endsGroup={endsGroup}
              isFirst={index === 0}
              selected={selectedIds.has(msg.id)}
              saved={isMessageSaved('message', currentSessionId, msg.id, savedMessages)}
              searchMatch={searchMatches.includes(msg.id)}
              activeSearchMatch={currentSearchId === msg.id}
              onResend={resendMessage}
              onShowThinking={(t) => setThinkingContent(t)}
              onPointerDown={(event) => handleMessagePointerDown(msg, event)}
              onPointerUp={clearLongPressTimer}
              onContextMenu={(event) => {
                event.preventDefault()
                openActionMenu(msg, event.clientX, event.clientY)
              }}
              onSelect={() => toggleSelection(msg.id)}
              onReplyJump={() => {
                const targetId = resolveReplyTargetId(msg)
                if (targetId) scrollToMessage(targetId)
              }}
              selecting={selectedIds.size > 0}
            />
          )
        })}
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="cc-selection-toolbar cc-fade-in">
          <span>{selectedIds.size} selected</span>
          <div>
            <button type="button" onClick={() => saveMessages(Array.from(selectedIds))}>Save</button>
            <button type="button" onClick={() => deleteSelectedMessages(Array.from(selectedIds))}>Delete</button>
            <button type="button" onClick={() => setSelectedIds(new Set())}>Cancel</button>
          </div>
        </div>
      )}

      {actionMenu && (
        <MessageActionMenu
          x={actionMenu.x}
          y={actionMenu.y}
          onClose={() => setActionMenu(null)}
          onReply={() => {
            setReplyTo(toReplyTarget(actionMenu.message))
            setActionMenu(null)
          }}
          onCopy={() => copyMessage(actionMenu.message)}
          onSelect={() => {
            toggleSelection(actionMenu.message.id)
            setActionMenu(null)
          }}
          onSave={() => {
            setSavedMessages(toggleSavedMessage('message', currentSessionId, actionMenu.message))
            setActionMenu(null)
          }}
          onDelete={() => deleteSelectedMessages([actionMenu.message.id])}
          saveLabel={isMessageSaved('message', currentSessionId, actionMenu.message.id, savedMessages) ? 'Unsave' : 'Save'}
        />
      )}

      <ChatComposer
        mode="message"
        value={input}
        onChange={setInput}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onSend={(payload) => {
          setInput('')
          setReplyTo(null)
          sendMessage(payload)
        }}
        placeholder="Message..."
        keepFocusAfterSend
      />

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

function MessageBubble({
  message,
  previousRole,
  startsGroup,
  endsGroup,
  isFirst,
  selected,
  saved,
  searchMatch,
  activeSearchMatch,
  selecting,
  onResend,
  onShowThinking,
  onPointerDown,
  onPointerUp,
  onContextMenu,
  onSelect,
  onReplyJump,
}: {
  message: ChatMessage
  previousRole?: ChatMessage['role']
  startsGroup: boolean
  endsGroup: boolean
  isFirst: boolean
  selected: boolean
  saved: boolean
  searchMatch: boolean
  activeSearchMatch: boolean
  selecting: boolean
  onResend?: (messageId: string) => void
  onShowThinking: (thinking: string) => void
  onPointerDown: (event: PointerEvent) => void
  onPointerUp: () => void
  onContextMenu: (event: ReactMouseEvent) => void
  onSelect: () => void
  onReplyJump: () => void
}) {
  if (message.notice) {
    return <ConnectionNotice type={message.notice} timestamp={message.timestamp} />
  }

  const isUser = message.role === 'user'
  const textBlocks = message.content.filter((b) => b.type === 'text')
  const visibleTextBlocks = isUser
    ? textBlocks
        .map((block) => ('text' in block ? stripUserstyleBlock(block.text) : ''))
        .filter(Boolean)
    : textBlocks.map((block) => ('text' in block ? block.text : '')).filter(Boolean)
  const thinkingBlocks = message.content.filter((b) => b.type === 'thinking')
  const hasThinking = thinkingBlocks.length > 0
  const thinkingText = hasThinking && 'thinking' in thinkingBlocks[0] ? thinkingBlocks[0].thinking : ''
  const imageBlocks = message.content.filter((b): b is ImageBlock => b.type === 'image')
  const audioBlocks = message.content.filter((b): b is AudioBlock => b.type === 'audio')
  const documentBlocks = message.content.filter((b): b is DocumentBlock => b.type === 'document')
  const toolUseBlocks = message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
  const toolResultBlocks = message.content.filter((b): b is ToolResultBlock => b.type === 'tool_result')

  const hasAttachments = imageBlocks.length > 0 || audioBlocks.length > 0 || documentBlocks.length > 0 || toolUseBlocks.length > 0
  const hasVisibleContent = visibleTextBlocks.length > 0 || hasAttachments

  if (isUser && !hasVisibleContent) return null

  const shapeClass = getBubbleShapeClass(isUser, startsGroup, endsGroup)
  const topSpacing = isFirst
    ? ''
    : previousRole && previousRole !== message.role
      ? 'mt-2'
      : startsGroup
        ? 'mt-1.5'
        : 'mt-[3px]'

  const textBubble = visibleTextBlocks.length > 0 ? (
    <div
      onClick={hasThinking && !selecting ? () => onShowThinking(thinkingText) : undefined}
      className={`relative min-w-0 max-w-full break-words px-3 py-1.5 text-[14px] leading-[1.42] ${shapeClass} ${
        isUser
          ? `cc-user-bubble text-white ${endsGroup && audioBlocks.length === 0 ? 'cc-bubble-tail-user' : ''}`
          : hasThinking
            ? `cc-assistant-bubble cc-thinking-bubble cursor-pointer text-[var(--cc-text)] transition-transform active:scale-[0.98] ${endsGroup && audioBlocks.length === 0 ? 'cc-bubble-tail-assistant' : ''}`
            : `cc-assistant-bubble text-[var(--cc-text)] ${endsGroup && audioBlocks.length === 0 ? 'cc-bubble-tail-assistant' : ''}`
      }`}
    >
      {message.replyTo && (
        <button
          type="button"
          className={`cc-inline-reply ${isUser ? 'is-user' : 'is-assistant'}`}
          onClick={(event) => {
            event.stopPropagation()
            if (selecting) onSelect()
            else onReplyJump()
          }}
        >
          <span>{message.replyTo.role === 'user' ? 'You' : 'Claude'}</span>
          <p>{message.replyTo.text}</p>
        </button>
      )}
      {visibleTextBlocks.map((text, i) => (
        <p key={i} className="cc-bubble-text">{text}</p>
      ))}
    </div>
  ) : null

  return (
    <div
      id={messageDomId(message.id)}
      className={`cc-fade-in relative flex min-w-0 ${topSpacing} ${isUser ? 'justify-end' : 'justify-start'} ${
        selected ? 'cc-message-selected' : ''
      } ${searchMatch ? 'cc-message-search-hit' : ''} ${activeSearchMatch ? 'cc-message-search-current' : ''}`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onContextMenu}
      onClick={selecting ? onSelect : undefined}
    >
      {selecting && (
        <button
          type="button"
          aria-label={selected ? 'Unselect message' : 'Select message'}
          onClick={(event) => {
            event.stopPropagation()
            onSelect()
          }}
          className={`cc-message-select-dot ${isUser ? 'is-user' : 'is-assistant'} ${selected ? 'is-selected' : ''}`}
        >
          {selected ? <CheckIcon /> : null}
        </button>
      )}
      <div className={`flex min-w-0 max-w-[86%] flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
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
            isUser={isUser}
          />
        ))}

        {audioBlocks.map((block, i) => (
          <VoiceBubble
            key={`audio-${i}`}
            cacheKey={voiceCacheKey(message.id, i)}
            url={block.url}
            duration={block.duration}
            transcript={block.transcript}
            isUser={isUser}
          />
        ))}

        {!isUser && toolUseBlocks.map((block) => (
          <ToolUsePill
            key={block.id}
            block={block}
            result={toolResultBlocks.find((result) => result.tool_use_id === block.id)}
          />
        ))}

        {textBubble}

        {endsGroup && (
          <p className={`px-0.5 text-[10px] text-[var(--cc-dim)] ${isUser ? 'text-right' : 'text-left'}`}>
            {isUser && message.sendStatus && (
              <SendStatus status={message.sendStatus} onResend={onResend ? () => onResend(message.id) : undefined} />
            )}
            {formatTimestamp(message.timestamp)}
            {saved && <span className="ml-1 text-[var(--cc-primary)]">saved</span>}
          </p>
        )}
      </div>
    </div>
  )
}

function MessageActionMenu({
  x,
  y,
  onReply,
  onCopy,
  onSelect,
  onSave,
  onDelete,
  onClose,
  saveLabel,
}: {
  x: number
  y: number
  onReply: () => void
  onCopy: () => void
  onSelect: () => void
  onSave: () => void
  onDelete: () => void
  onClose: () => void
  saveLabel: string
}) {
  return (
    <>
      <button type="button" aria-label="Close message actions" className="cc-action-menu-scrim" onClick={onClose} />
      <div className="cc-message-action-menu cc-fade-in" style={{ left: x, top: y }}>
        <button type="button" onClick={onCopy}>Copy</button>
        <button type="button" onClick={onReply}>Reply</button>
        <button type="button" onClick={onSelect}>Select</button>
        <button type="button" onClick={onSave}>{saveLabel}</button>
        <button type="button" onClick={onDelete} className="is-danger">Delete</button>
      </div>
    </>
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

function ToolUsePill({ block, result }: { block: ToolUseBlock; result?: ToolResultBlock }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="cc-tool-use-pill max-w-full">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex max-w-full items-center gap-1.5 px-2.5 py-1.5 text-[11px]"
      >
        <span className="text-[9px]">{open ? '▾' : '▸'}</span>
        <span className="min-w-0 truncate font-mono">{block.name}</span>
      </button>
      {open && (
        <div className="max-h-44 overflow-y-auto px-2.5 pb-2 font-mono text-[11px] leading-snug text-[var(--cc-sub)]">
          <pre className="whitespace-pre-wrap">{JSON.stringify(block.input, null, 2)}</pre>
          {result?.content && (
            <pre className="mt-2 whitespace-pre-wrap opacity-75">{result.content}</pre>
          )}
        </div>
      )}
    </div>
  )
}

function messageDomId(messageId: string) {
  return `message-${messageId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

function normalizeForMatch(text: string) {
  return text.replace(/\s+/g, ' ').trim().replace(/(\.{3}|…)$/, '').trim().toLowerCase()
}

function toReplyTarget(message: ChatMessage): ReplyTarget {
  return {
    messageId: message.id,
    role: message.role,
    text: messagePreview(message, 240),
    timestamp: message.timestamp,
  }
}

async function writeClipboardText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  }
}

function CheckIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m5 13 4 4L19 7" />
    </svg>
  )
}

function isSameMessageGroup(current?: ChatMessage, next?: ChatMessage) {
  if (!current || !next) return false
  if (current.notice || next.notice) return false
  if (current.role !== next.role) return false
  return next.timestamp - current.timestamp < GROUP_TIME_WINDOW_MS
}

function getBubbleShapeClass(isUser: boolean, startsGroup: boolean, endsGroup: boolean) {
  if (isUser) {
    if (startsGroup && endsGroup) return 'rounded-[18px] rounded-br-[6px]'
    if (startsGroup) return 'rounded-[18px] rounded-br-[6px]'
    if (endsGroup) return 'rounded-[18px] rounded-tr-[6px]'
    return 'rounded-[18px] rounded-r-[6px]'
  }

  if (startsGroup && endsGroup) return 'rounded-[18px] rounded-bl-[6px]'
  if (startsGroup) return 'rounded-[18px] rounded-bl-[6px]'
  if (endsGroup) return 'rounded-[18px] rounded-tl-[6px]'
  return 'rounded-[18px] rounded-l-[6px]'
}
