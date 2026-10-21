import { z } from 'zod';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { watchId } from './exceptions.js';
import { address } from './symbols.js';

const count = z.number().int().nonnegative().safe();
export const dumpOptions = z.object({
  frames: z.number().int().min(1).max(300).default(1),
  timeout_ms: z.number().int().min(100).max(30000).default(15000),
  max_bytes: z.number().int().min(1024 * 1024).max(256 * 1024 * 1024).default(64 * 1024 * 1024),
});
export type DumpOptions = z.input<typeof dumpOptions>;
const response = z.object({
  ok: z.literal(true), operation_id: watchId,
  state: z.enum(['queued', 'recording', 'cancelling', 'closed', 'cancelled', 'expired', 'invalidated', 'failed']),
  active: z.boolean(), reason: z.string(), session: count, execution_epoch: count,
  elf: z.string(), elf_crc: address, path: z.string().min(1),
  frames_requested: z.number().int().min(1).max(300), bytes_submitted: count,
  max_bytes: dumpOptions.shape.max_bytes.removeDefault(), format: z.literal('uncompressed_gs'),
});

export function parseDump(value: unknown, id: string) {
  const result = response.parse(value);
  if (result.operation_id !== id || result.active !== ['queued', 'recording', 'cancelling'].includes(result.state) ||
      result.bytes_submitted > result.max_bytes || !result.path.replaceAll('\\', '/').endsWith(`/${id}.gs`))
    throw new Error('Inconsistent GS dump ownership/state/budget');
  return result;
}

// Validate the actual closed uncompressed stream, not file existence alone.
// Read packet headers in bounded buffers; transfer/state payloads are skipped.
export async function verifyDump(filename: string, maxBytes: number, minimumFrames: number, signal?: AbortSignal) {
  dumpOptions.shape.max_bytes.parse(maxBytes); dumpOptions.shape.frames.parse(minimumFrames);
  const deadline = performance.now() + 15000;
  const check = () => { signal?.throwIfAborted(); if (performance.now() >= deadline) throw new Error('GS dump verification exceeded 15 seconds'); };
  const file = await fs.open(filename, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maxBytes || before.size < 44 + 8192) throw new Error('GS dump has an invalid file size');
    const cache = Buffer.alloc(65536);
    let cacheStart = -1, cacheBytes = 0;
    const read = async (offset: number, length: number) => {
      check();
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > before.size) throw new Error('Truncated GS dump');
      if (offset < cacheStart || offset + length > cacheStart + cacheBytes) {
        const result = await file.read(cache, 0, Math.min(cache.length, before.size - offset), offset);
        cacheStart = offset; cacheBytes = result.bytesRead;
      }
      if (offset + length > cacheStart + cacheBytes) throw new Error('Truncated GS dump');
      return cache.subarray(offset - cacheStart, offset - cacheStart + length);
    };
    const header = Buffer.from(await read(0, 44));
    if (header.readUInt32LE(0) !== 0xffffffff) throw new Error('Expected the pinned PCSX2 GS dump header');
    if (header.readUInt32LE(8) !== 9) throw new Error('Unsupported GS dump state version (expected v2.6.3 state 9)');
    const headerBytes = header.readUInt32LE(4), stateBytes = header.readUInt32LE(12);
    const serialOffset = header.readUInt32LE(16), serialBytes = header.readUInt32LE(20);
    const width = header.readUInt32LE(28), height = header.readUInt32LE(32);
    const imageOffset = header.readUInt32LE(36), imageBytes = header.readUInt32LE(40);
    if (headerBytes < 36 || headerBytes > 16 * 1024 * 1024 || stateBytes === 0 || stateBytes > maxBytes ||
        serialOffset < 36 || serialOffset + serialBytes > headerBytes ||
        width > 640 || height > 480 || imageBytes !== width * height * 4 ||
        imageOffset < serialOffset + serialBytes || imageOffset + imageBytes > headerBytes)
      throw new Error('Invalid GS dump state/serial/screenshot extents');
    let offset = 8 + headerBytes + stateBytes + 8192;
    if (offset > before.size) throw new Error('Truncated GS dump initial state');
    let vsyncs = 0, packets = 0;
    while (offset < before.size) {
      if (++packets > 2_000_000) throw new Error('GS dump packet budget exceeded');
      const kind = (await read(offset++, 1))[0];
      if (kind === 0) {
        const transfer = await read(offset, 5);
        if (transfer[0] > 3) throw new Error('Invalid GS transfer path');
        offset += 5 + transfer.readUInt32LE(1);
      } else if (kind === 1) {
        const field = (await read(offset++, 1))[0];
        if (field > 1) throw new Error('Invalid GS field');
        vsyncs++;
      } else if (kind === 2) {
        if ((await read(offset, 4)).readUInt32LE(0) >= Math.floor(maxBytes / 16)) throw new Error('GS FIFO read exceeds the byte budget');
        offset += 4;
      }
      else if (kind === 3) offset += 8192;
      else throw new Error(`Invalid GS packet type ${kind}`);
      if (offset > before.size) throw new Error('Truncated GS packet');
    }
    if (vsyncs < minimumFrames) throw new Error('GS dump ended before the requested video boundaries');
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) { check(); hash.update(chunk); }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('GS dump changed during validation');
    return { verified: true as const, bytes: before.size, sha256: hash.digest('hex'), vsync_packets: vsyncs,
      state_version: header.readUInt32LE(8), gs_crc: '0x' + header.readUInt32LE(24).toString(16).padStart(8, '0'),
      screenshot_width: width, screenshot_height: height };
  } finally { await file.close(); }
}
