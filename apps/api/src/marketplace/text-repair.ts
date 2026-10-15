// SPDX-License-Identifier: AGPL-3.0-only

// Some upstream catalog entries were saved after their UTF-8 bytes were decoded
// as windows-1252 ("🗂️" became "ðŸ—‚ï¸"). Reverse that, and leave the text
// untouched unless it round-trips into valid UTF-8.

const cp1252 = new TextDecoder("windows-1252")
const reverse = new Map<string, number>()
for (let byte = 0x80; byte <= 0x9f; byte++) {
  reverse.set(cp1252.decode(Uint8Array.of(byte)), byte)
}
const utf8 = new TextDecoder("utf-8", { fatal: true })

// A UTF-8 lead byte (0xC2-0xF4) followed by a continuation byte, as seen
// through windows-1252.
const SUSPECT =
  /[Â-ô][\u0080-¿ŒœŠšŸŽžƒˆ˜–—‘-„†-•…‰‹›€™]/

export function repairMojibake(text: string): string {
  if (!SUSPECT.test(text)) return text
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    const code = ch.charCodeAt(0)
    const byte = code <= 0xff ? code : reverse.get(ch)
    if (byte === undefined) return text
    bytes[i] = byte
  }
  try {
    return utf8.decode(bytes)
  } catch {
    return text
  }
}
