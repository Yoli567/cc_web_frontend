import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownContentProps {
  text: string
  isStreaming?: boolean
}

/**
 * Renders a markdown string with our themed styles.
 * When `isStreaming` is true, a blinking cursor is appended to the last
 * rendered element via CSS (.cc-md-content.cc-streaming > *:last-child::after).
 */
export default function MarkdownContent({ text, isStreaming = false }: MarkdownContentProps) {
  return (
    <div className={`cc-md-content ${isStreaming ? 'cc-streaming' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Open links in a new tab so we don't navigate away from the chat
          a: ({ ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
