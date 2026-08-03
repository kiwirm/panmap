/** Escape `&`, `<`, `>` for XML text content. Does NOT escape `"` — that's
 *  only significant inside attribute values, use `escapeXmlAttr` there. */
export function escapeXmlText(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape any value for XML attribute content (also escapes `"`). */
export function escapeXmlAttr(value: unknown): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}
