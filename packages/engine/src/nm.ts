import type { Readable, Writable } from 'node:stream';
import { MAX_REQUEST_BYTES } from '@repomind/core';

/**
 * Chrome Native Messaging framing: each message is a 32-bit unsigned length in native byte order
 * (little-endian on every platform RepoMind targets) followed by UTF-8 JSON.
 */
export class NativeMessagingIO {
  private buffer: Buffer = Buffer.alloc(0);
  private writing: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly onMessage: (msg: unknown) => void,
    private readonly onError: (err: Error) => void,
    private readonly onClose: () => void
  ) {
    input.on('data', (chunk: Buffer) => this.feed(chunk));
    input.on('end', () => this.close());
    input.on('error', (e) => this.onError(e));
    output.on('error', (e) => this.onError(e));
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  private feed(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32LE(0);
      if (len > MAX_REQUEST_BYTES) {
        this.onError(new Error(`Incoming message of ${len} bytes exceeds the ${MAX_REQUEST_BYTES} byte limit; closing.`));
        this.buffer = Buffer.alloc(0);
        this.input.destroy();
        this.close();
        return;
      }
      if (this.buffer.length < 4 + len) return;
      const body = this.buffer.subarray(4, 4 + len).toString('utf8');
      this.buffer = this.buffer.subarray(4 + len);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        this.onError(new Error('Received a message that is not valid JSON.'));
        continue;
      }
      this.onMessage(parsed);
    }
  }

  /** Serializes writes so frames never interleave. */
  send(msg: unknown): Promise<void> {
    const json = Buffer.from(JSON.stringify(msg), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    const frame = Buffer.concat([header, json]);
    this.writing = this.writing.then(
      () =>
        new Promise<void>((resolve) => {
          if (this.closed && this.output.destroyed) return resolve();
          if (this.output.write(frame)) resolve();
          else this.output.once('drain', () => resolve());
        })
    );
    return this.writing;
  }
}

export function encodeFrame(msg: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

/** Incremental decoder for tests and the e2e harness. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + len) break;
      out.push(JSON.parse(this.buf.subarray(4, 4 + len).toString('utf8')));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}
