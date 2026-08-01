import { ProtocolError } from '../Defaults/errors';

/**
 * WhatsApp websocket framing: each frame is `[3-byte BE length][payload]`.
 * Streams may carry several frames in one WS message; a frame may also be
 * split across WS messages — this codec handles both.
 */

export const WS_FRAME_HEADER_SIZE = 3;
/** Largest single frame we accept (DoS guard) */
export const WS_FRAME_MAX_SIZE = 8 * 1024 * 1024;

export function encodeFrame(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > 0xffffff) throw new ProtocolError(`frame too large (${payload.byteLength})`);
  const out = new Uint8Array(WS_FRAME_HEADER_SIZE + payload.byteLength);
  out[0] = (payload.byteLength >> 16) & 0xff;
  out[1] = (payload.byteLength >> 8) & 0xff;
  out[2] = payload.byteLength & 0xff;
  out.set(payload, WS_FRAME_HEADER_SIZE);
  return out;
}

/** Incremental frame splitter — feed arbitrary WS byte chunks */
export class FrameDecoder {
  #buffer: Uint8Array = new Uint8Array(0);

  /** Returns all complete frames contained in the newly fed chunk(s) */
  feed(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength === 0) return [];
    const merged = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    merged.set(this.#buffer, 0);
    merged.set(chunk, this.#buffer.byteLength);
    this.#buffer = merged;

    const frames: Uint8Array[] = [];
    let offset = 0;
    while (offset + WS_FRAME_HEADER_SIZE <= this.#buffer.byteLength) {
      const length =
        ((this.#buffer[offset] ?? 0) << 16) | ((this.#buffer[offset + 1] ?? 0) << 8) | (this.#buffer[offset + 2] ?? 0);
      if (length > WS_FRAME_MAX_SIZE) {
        this.#buffer = new Uint8Array(0);
        throw new ProtocolError(`incoming frame size ${length} exceeds cap`);
      }
      if (offset + WS_FRAME_HEADER_SIZE + length > this.#buffer.byteLength) break;
      frames.push(this.#buffer.subarray(offset + WS_FRAME_HEADER_SIZE, offset + WS_FRAME_HEADER_SIZE + length));
      offset += WS_FRAME_HEADER_SIZE + length;
    }
    this.#buffer = this.#buffer.subarray(offset);
    return frames;
  }

  get bufferedBytes(): number {
    return this.#buffer.byteLength;
  }

  reset(): void {
    this.#buffer = new Uint8Array(0);
  }
}
