const USERSTYLE_BLOCK_RE = /^<userstyle>[\s\S]*?<\/userstyle>\s*/i

export function stripUserstyleBlock(text: string) {
  return text.replace(USERSTYLE_BLOCK_RE, '').trimStart()
}
