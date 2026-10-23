import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { watchId } from './exceptions.js';
import { address } from './symbols.js';

export const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const movieOptions = z.object({
  frames: z.number().int().min(1).max(600).default(120),
  timeout_ms: z.number().int().min(100).max(30000).default(15000),
});
export type MovieOptions = z.input<typeof movieOptions>;
export const replayOptions = z.object({ path: z.string().min(1).max(4096), movie_sha256: sha256,
  elf_sha256: sha256, timeout_ms: movieOptions.shape.timeout_ms });
export type ReplayOptions = z.input<typeof replayOptions>;
const count = z.number().int().nonnegative().safe();
const response = z.object({ ok: z.literal(true), operation_id: watchId, mode: z.enum(['record', 'replay']),
  state: z.enum(['active', 'closed', 'failed']), active: z.boolean(), reason: z.string(), path: z.string(), source: z.string(),
  session: count, execution_epoch: count, elf: z.string(), elf_crc: address, elf_sha256: sha256,
  input_sha256: z.union([sha256, z.literal('')]),
  frames: count, max_frames: movieOptions.shape.frames.removeDefault(), start: z.literal('power_on'), paused: z.boolean() });

export function parseMovie(value: unknown, id: string) {
  const result = response.parse(value);
  if (result.operation_id !== id || result.active !== (result.state === 'active') || result.frames > result.max_frames ||
      !path.isAbsolute(result.path) || path.basename(result.path) !== `${id}.p2m2` ||
      (result.mode === 'record' ? result.source !== '' : !path.isAbsolute(result.source)) ||
      (result.mode === 'record' ? result.input_sha256 !== '' : result.input_sha256 === '') ||
      (result.reason === 'eof' && (result.mode !== 'replay' || result.frames !== result.max_frames || result.active)) ||
      (result.reason === 'frame_limit' && (result.mode !== 'record' || result.frames !== result.max_frames || result.active)))
    throw new Error('Inconsistent input movie identity/state/budget');
  return result;
}

// Stable bounded reads: hash the open file and reject replacement/modification
// while reading. No movie or ELF bytes are returned over MCP.
export async function hashLocalFile(filename: string, maxBytes: number, signal?: AbortSignal) {
  if (!path.isAbsolute(filename)) throw new Error('Expected an absolute local file path');
  signal?.throwIfAborted();
  const file = await fs.open(filename, 'r');
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maxBytes)) throw new Error('File size exceeds its bounds or is empty');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error('File truncated during verification');
      offset += read.bytesRead;
    }
    const after = await file.stat({ bigint: true }), current = await fs.stat(filename, { bigint: true });
    for (const candidate of [after, current])
      for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const)
        if (before[key] !== candidate[key]) throw new Error('File changed during verification');
    signal?.throwIfAborted();
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { await file.close(); }
}

export function parseP2m2(bytes: Buffer) {
  if (bytes.length < 570 || bytes.length > 570 + 36 * 600 || bytes[0] !== 1 || bytes[569] > 1)
    throw new Error('Expected a bounded p2m2 v1 header');
  const text = (offset: number, size: number) => {
    const field = bytes.subarray(offset, offset + size), end = field.indexOf(0);
    if (end < 0) throw new Error('Unterminated p2m2 header string');
    return field.subarray(0, end).toString('utf8');
  };
  const frames = bytes.readUInt32LE(561);
  if (frames < 1 || frames > 600 || bytes.length !== 570 + frames * 36)
    throw new Error('Truncated, trailing or invalid p2m2 frame data');
  return { format: 'p2m2_v1' as const, frames, bytes: bytes.length, from_savestate: bytes[569] === 1,
    undo_count: bytes.readUInt32LE(565), emulator: text(1, 50), author: text(51, 255), game: text(306, 255),
    ports: 2, bytes_per_pad: 18, determinism: 'not_established' as const };
}

export async function inspectMovie(filename: string, signal?: AbortSignal) {
  const data = await hashLocalFile(filename, 570 + 36 * 600, signal);
  return { ...parseP2m2(data.bytes), path: filename, sha256: data.sha256, verified: true };
}
