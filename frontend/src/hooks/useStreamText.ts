// JSONL is batch-written by Claude Code — chunks arrive as whole blocks,
// not token-by-token. Faking a typing animation only delays the user
// from reading. So we just display fullText immediately; the streaming
// cursor (▎) still indicates "in progress" via isStreaming.

export function useStreamText(fullText: string, isStreaming: boolean) {
  return { displayed: fullText, isDone: !isStreaming }
}
