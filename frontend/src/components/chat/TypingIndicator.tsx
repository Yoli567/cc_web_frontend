export default function TypingIndicator() {
  return (
    <div className="cc-fade-in flex justify-start">
      <div className="cc-assistant-bubble cc-typing-bubble rounded-2xl rounded-bl-md px-4 py-3">
        <div className="cc-typing-dots flex items-center gap-1">
          <span className="cc-dot h-1.5 w-1.5 rounded-full bg-[var(--cc-primary)] opacity-60 [animation-delay:0ms]" />
          <span className="cc-dot h-1.5 w-1.5 rounded-full bg-[var(--cc-primary)] opacity-60 [animation-delay:160ms]" />
          <span className="cc-dot h-1.5 w-1.5 rounded-full bg-[var(--cc-primary)] opacity-60 [animation-delay:320ms]" />
        </div>
      </div>
    </div>
  )
}
