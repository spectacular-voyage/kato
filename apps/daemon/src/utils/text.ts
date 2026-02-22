export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
