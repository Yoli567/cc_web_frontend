import type { ConnectionNoticeType } from '@/types'
import { formatTimestamp } from '@/utils/formatTime'

export default function ConnectionNotice({
  type,
  timestamp,
}: {
  type: ConnectionNoticeType
  timestamp: number
}) {
  const disconnected = type === 'disconnected'
  return (
    <div className="cc-fade-in flex justify-center py-1">
      <span className={`cc-connection-notice ${disconnected ? 'is-disconnected' : 'is-reconnected'}`}>
        <span className="cc-connection-notice-dot" />
        {disconnected ? 'WebSocket disconnected' : 'WebSocket reconnected'}
        <span className="cc-connection-notice-time">{formatTimestamp(timestamp)}</span>
      </span>
    </div>
  )
}
