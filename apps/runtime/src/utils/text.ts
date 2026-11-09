export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const UTF8_ENCODER = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return UTF8_ENCODER.encode(text).length;
}
