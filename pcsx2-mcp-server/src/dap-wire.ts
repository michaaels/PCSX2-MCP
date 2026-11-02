import { z } from 'zod';

export const dapRequest = z.object({ seq: z.number().int().min(1).max(2147483647),
  type: z.literal('request'), command: z.string().min(1).max(128),
  arguments: z.record(z.unknown()).optional() });
export type DapRequest = z.infer<typeof dapRequest>;
const MAX_MESSAGE = 1024 * 1024;

/** DAP byte framing. Header and JSON budgets are independent of chunk boundaries. */
export class DapFramer {
  private buffer = Buffer.alloc(0);
  private length: number | undefined;
  constructor(private receive: (request: DapRequest) => void) {}
  feed(chunk: Buffer) {
    // A stream chunk can contain several messages, each independently bounded.
    for (let offset = 0; offset < chunk.length; offset += 16384) {
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, offset + 16384)]);
      for (;;) {
        if (this.length === undefined) {
          const end = this.buffer.indexOf('\r\n\r\n');
          if (end < 0) { if (this.buffer.length > 1024) throw new Error('DAP header exceeds 1024 bytes'); break; }
          if (end > 1024) throw new Error('DAP header exceeds 1024 bytes');
          const header = this.buffer.subarray(0, end).toString('ascii');
          if (!/^Content-Length: [1-9][0-9]{0,6}$/i.test(header)) throw new Error('Expected exactly one DAP Content-Length header');
          this.length = Number(header.slice(header.indexOf(':') + 1));
          if (this.length > MAX_MESSAGE) throw new Error('DAP message exceeds 1 MiB');
          this.buffer = this.buffer.subarray(end + 4);
        }
        if (this.buffer.length < this.length) break;
        const body = this.buffer.subarray(0, this.length);
        this.buffer = this.buffer.subarray(this.length); this.length = undefined;
        // TextDecoder with fatal rejects invalid UTF-8 rather than replacing bytes.
        this.receive(dapRequest.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))));
      }
    }
  }
  end() { if (this.buffer.length || this.length !== undefined) throw new Error('Truncated DAP message'); }
}

export function encodeDap(message: unknown) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_MESSAGE) throw new Error('DAP response exceeds 1 MiB');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}
