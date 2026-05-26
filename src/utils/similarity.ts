import type { Token } from "./tokenize.js";

export function hashWindow(tokens: Token[], start: number, length: number): string {
  let h1 = 0xcbf29ce4 | 0;
  let h2 = 0x84222325 | 0;
  for (let i = 0; i < length; i++) {
    const s = tokens[start + i].normalized;
    for (let j = 0; j < s.length; j++) {
      const c = s.charCodeAt(j);
      h1 ^= c;
      const a = Math.imul(h1, 0x000001b3);
      const b = Math.imul(h2, 0x000001b3) + Math.imul(h1, 0x00000100);
      h1 = a | 0;
      h2 = (b + (a >>> 0 > 0xffffffff ? 1 : 0)) | 0;
    }
    h1 ^= 0x2c;
    h1 = Math.imul(h1, 0x000001b3) | 0;
  }
  return `${(h2 >>> 0).toString(16)}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
}

export function rawIdentityRatio(a: Token[], b: Token[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let identical = 0;
  for (let i = 0; i < len; i++) {
    if (a[i].text === b[i].text) identical++;
  }
  return identical / len;
}
