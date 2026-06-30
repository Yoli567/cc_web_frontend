export default function ScrollToBottomButton({
  visible,
  onClick,
}: {
  visible: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label="Scroll to bottom"
      title="Scroll to bottom"
      onClick={onClick}
      className={`cc-scroll-bottom-button ${visible ? 'is-visible' : ''}`}
    >
      <DownIcon />
    </button>
  )
}

function DownIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
    </svg>
  )
}
