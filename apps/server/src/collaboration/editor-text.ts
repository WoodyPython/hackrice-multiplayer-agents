/**
 * Monaco uses one end-of-line sequence per model. Yjs offsets must therefore
 * be based on the same text Monaco displays; retaining mixed CRLF/LF input can
 * shift later edits onto the wrong line because CRLF occupies two Yjs units.
 */
export function normalizeEditorText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}
