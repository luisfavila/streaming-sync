// Stremio stores which episodes of a series are watched as one string on the library item:
//
//   "<anchorVideoId>:<anchorLength>:<base64(zlib(bytes))>"
//
// Bit i (byte i>>3, mask 1<<(i&7)) is set when the i-th video is watched, with videos ordered by
// season, then episode, then release date. The anchor is the last watched video and its 1-based
// position; when a series gains or loses episodes, the anchor is used to realign the bits.
// The video id itself may contain ":" ("tt123:1:5"), so the string is parsed from the right.
//
// Port of stremio-core's stremio-watched-bitfield crate.

import { deflate, inflate } from 'pako';

const toBase64 = (bytes: Uint8Array) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export interface CinemetaVideo {
  id: string;
  season?: number;
  episode?: number;
  released?: string;
}

/** Orders a series' videos the way Stremio does before indexing the bitfield. */
export function orderVideoIds(videos: CinemetaVideo[]): string[] {
  const key = (n: number | undefined) => (n === undefined || n === null ? -Infinity : n);
  const hasInfo = (v: CinemetaVideo) => v.season !== undefined && v.season !== null && v.episode !== undefined && v.episode !== null;
  const released = (v: CinemetaVideo) => (v.released ? Date.parse(v.released) : -Infinity);
  return [...videos]
    .sort((a, b) => {
      const sa = hasInfo(a) ? key(a.season) : -Infinity;
      const sb = hasInfo(b) ? key(b.season) : -Infinity;
      if (sa !== sb) return sa < sb ? -1 : 1;
      const ea = hasInfo(a) ? key(a.episode) : -Infinity;
      const eb = hasInfo(b) ? key(b.episode) : -Infinity;
      if (ea !== eb) return ea < eb ? -1 : 1;
      const ra = released(a);
      const rb = released(b);
      return ra === rb ? 0 : ra < rb ? -1 : 1;
    })
    .map((v) => v.id);
}

export class WatchedBitField {
  readonly videoIds: string[];
  private bits: Uint8Array;

  private constructor(videoIds: string[], bits: Uint8Array) {
    this.videoIds = videoIds;
    this.bits = bits;
  }

  static empty(videoIds: string[]): WatchedBitField {
    return new WatchedBitField(videoIds, new Uint8Array(Math.ceil(videoIds.length / 8)));
  }

  /**
   * Decodes Stremio's serialized string against the series' current (ordered) video list.
   * A string that can't be read or lined up gives an empty field, as in Stremio. Use tryParse
   * before writing a field back, so an unreadable string isn't replaced with a blank one.
   */
  static parse(serialized: string | null | undefined, videoIds: string[]): WatchedBitField {
    return WatchedBitField.tryParse(serialized, videoIds) ?? WatchedBitField.empty(videoIds);
  }

  /** Like parse, but returns undefined when there is a string and it can't be read or lined up. */
  static tryParse(serialized: string | null | undefined, videoIds: string[]): WatchedBitField | undefined {
    const out = WatchedBitField.empty(videoIds);
    if (!serialized) return out;
    const parts = serialized.split(':');
    if (parts.length < 3) return undefined;
    const encoded = parts.pop()!;
    const anchorLength = Number.parseInt(parts.pop()!, 10);
    const anchorVideo = parts.join(':');
    let old: Uint8Array;
    try {
      old = inflate(fromBase64(encoded));
    } catch {
      return undefined;
    }
    const oldLength = old.length * 8;
    const anchorIdx = videoIds.indexOf(anchorVideo);
    if (anchorIdx === -1 || !Number.isFinite(anchorLength)) return undefined;
    const offset = anchorLength - anchorIdx - 1;
    for (let i = 0; i < videoIds.length; i++) {
      const prev = i + offset;
      if (prev >= 0 && prev < oldLength && (old[prev >> 3]! >> (prev & 7)) & 1) out.set(i, true);
    }
    return out;
  }

  get(i: number): boolean {
    return i >= 0 && i < this.videoIds.length && ((this.bits[i >> 3]! >> (i & 7)) & 1) === 1;
  }

  set(i: number, value: boolean): void {
    if (i < 0) return;
    const byte = i >> 3;
    if (byte >= this.bits.length) {
      const grown = new Uint8Array(byte + 1);
      grown.set(this.bits);
      this.bits = grown;
    }
    if (value) this.bits[byte]! |= 1 << (i & 7);
    else this.bits[byte]! &= ~(1 << (i & 7));
  }

  getVideo(id: string): boolean {
    return this.get(this.videoIds.indexOf(id));
  }

  /** Returns true if the bit changed. Unknown ids are ignored. */
  setVideo(id: string, value: boolean): boolean {
    const i = this.videoIds.indexOf(id);
    if (i === -1 || this.get(i) === value) return false;
    this.set(i, value);
    return true;
  }

  watchedVideoIds(): string[] {
    return this.videoIds.filter((_, i) => this.get(i));
  }

  toString(): string {
    let last = -1;
    for (let i = this.videoIds.length - 1; i >= 0; i--) {
      if (this.get(i)) {
        last = i;
        break;
      }
    }
    const lastIdx = last === -1 ? 0 : last;
    const anchor = this.videoIds[lastIdx] ?? 'undefined';
    const encoded = toBase64(deflate(this.bits, { level: 6 }));
    return `${anchor}:${lastIdx + 1}:${encoded}`;
  }
}
