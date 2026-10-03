/** Validarea copertei urcate de creator: JPEG real (magic bytes FF D8 FF), nu doar Content-Type declarat. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export function coverObjectKey(videoId: string, nonce: string): string {
  return `videos/covers/${videoId}/${nonce}.jpg`;
}
