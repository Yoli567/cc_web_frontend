interface DocumentBubbleProps {
  url: string
  name: string
  size: number
  mimeType?: string
  isUser: boolean
}

export default function DocumentBubble({ url, name, size, mimeType, isUser }: DocumentBubbleProps) {
  return (
    <a
      href={url}
      download={name}
      target="_blank"
      rel="noopener noreferrer"
      className={`cc-document-bubble flex items-center gap-2.5 px-3 py-2.5 ${
        isUser ? 'cc-document-bubble-user' : 'cc-document-bubble-assistant'
      }`}
    >
      <span className="cc-document-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
        <FileGlyph mimeType={mimeType} />
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="cc-document-name truncate text-[13px] font-medium leading-tight">{name}</span>
        <span className="cc-document-meta mt-0.5 text-[11px] leading-tight opacity-75">
          {formatSize(size)}
        </span>
      </div>
    </a>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function FileGlyph({ mimeType }: { mimeType?: string }) {
  if (mimeType?.includes('pdf')) {
    return (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M14 3v5h5" />
        <text x="8" y="17" fontSize="5" fontWeight="700" fill="currentColor" stroke="none">PDF</text>
      </svg>
    )
  }
  if (mimeType?.includes('word') || mimeType?.includes('msword') || mimeType?.includes('officedocument')) {
    return (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M14 3v5h5M9 13l2 5 1-3 1 3 2-5" />
      </svg>
    )
  }
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 3v5h5M8 13h8M8 17h5" />
    </svg>
  )
}
