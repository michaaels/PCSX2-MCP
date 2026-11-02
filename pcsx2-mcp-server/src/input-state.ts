import { z } from 'zod';
import * as zlib from 'node:zlib';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { stat } from 'node:fs/promises';
import { hashLocalFile } from './input-movie.js';

export const inputStateOptions = z.object({ path: z.string().min(1).max(4096),
  expected_sha256: z.string().regex(/^[\da-fA-F]{64}$/).optional() });
export const inputStateLimits = Object.freeze({ archive_bytes: 128 * 1024 ** 2, expanded_bytes: 128 * 1024 ** 2,
  entry_bytes: 64 * 1024 ** 2, entries: 32, name_bytes: 128, zstd_window_log: 26, deadline_ms: 15000 });
const VERSION = 0x9a590000;
const required: Record<string, number | null> = {
  'PCSX2 Savestate Version.id': 36, 'PCSX2 Internal Structures.dat': null,
  'eeMemory.bin': 32 * 1024 ** 2, 'iopMemory.bin': 2 * 1024 ** 2,
  'eeHwRegs.bin': 65536, 'iopHwRegs.bin': 65536, 'Scratchpad.bin': 16384,
  'vu0Memory.bin': 4096, 'vu1Memory.bin': 16384, 'vu0MicroMem.bin': 4096, 'vu1MicroMem.bin': 16384,
  'SPU2.bin': null, 'USB.bin': null, 'PAD.bin': null, 'GS.bin': null,
};
type Entry = { name: string; method: number; crc32: number; packed: number; size: number; payload: number; end: number; offset: number };
function need(condition: unknown, message: string): asserts condition { if (!condition) throw new Error('Savestate archive: ' + message); }
function extras(bytes: Buffer) {
  for (let at = 0; at < bytes.length;) {
    need(at + 4 <= bytes.length, 'truncated extra field');
    const id = bytes.readUInt16LE(at), size = bytes.readUInt16LE(at + 2); at += 4;
    need(id !== 1, 'ZIP64 is outside the bounded companion subset'); need(at + size <= bytes.length, 'truncated extra value'); at += size;
  }
}
function directory(bytes: Buffer) {
  need(bytes.length >= 22 && bytes.length <= inputStateLimits.archive_bytes, 'file byte bounds');
  // The pinned producer writes a single-disk, comment-free ZIP32 archive.
  const end = bytes.length - 22; need(bytes.readUInt32LE(end) === 0x06054b50, 'missing finalized ZIP end record or trailing bytes');
  need(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0 && bytes.readUInt16LE(end + 20) === 0, 'multi-disk/commented archives unsupported');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  need(count >= 1 && count <= inputStateLimits.entries && bytes.readUInt16LE(end + 8) === count, 'entry count bounds');
  need(start + size === end && start < end, 'central directory extent mismatch');
  const entries: Entry[] = [], names = new Set<string>(); let at = start, expanded = 0;
  for (let n = 0; n < count; n++) {
    need(at + 46 <= end && bytes.readUInt32LE(at) === 0x02014b50, 'invalid central directory entry');
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), crc32 = bytes.readUInt32LE(at + 16);
    const packed = bytes.readUInt32LE(at + 20), length = bytes.readUInt32LE(at + 24), nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30), commentLength = bytes.readUInt16LE(at + 32), offset = bytes.readUInt32LE(at + 42);
    need(bytes.readUInt16LE(at + 34) === 0 && (flags & ~(0x800 | (method === 8 ? 6 : 0))) === 0 && [0, 8, 93].includes(method), 'unsupported flags, compression or disk');
    need(nameLength >= 1 && nameLength <= inputStateLimits.name_bytes && commentLength === 0 && at + 46 + nameLength + extraLength <= end, 'name/extra/comment bounds');
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength), name = nameBytes.toString('ascii');
    need(nameBytes.every(b => b >= 32 && b <= 126) && !/[\\/:]/.test(name) && name !== '.' && name !== '..', 'unsafe or non-ASCII entry name');
    need(!names.has(name.toLowerCase()), 'duplicate entry name'); names.add(name.toLowerCase());
    need(length >= 1 && length <= inputStateLimits.entry_bytes && packed >= 1 && packed !== 0xffffffff && offset < start, 'entry size/offset bounds');
    expanded += length; need(expanded <= inputStateLimits.expanded_bytes, 'expanded byte budget exceeded');
    extras(bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength));
    need(offset + 30 <= start && bytes.readUInt32LE(offset) === 0x04034b50, 'invalid local header');
    const localName = bytes.readUInt16LE(offset + 26), localExtra = bytes.readUInt16LE(offset + 28), payload = offset + 30 + localName + localExtra;
    need(localName === nameLength && payload + packed <= start && bytes.subarray(offset + 30, offset + 30 + localName).equals(nameBytes), 'local name or payload extent mismatch');
    need(bytes.readUInt16LE(offset + 6) === flags && bytes.readUInt16LE(offset + 8) === method &&
      bytes.readUInt32LE(offset + 14) === crc32 && bytes.readUInt32LE(offset + 18) === packed && bytes.readUInt32LE(offset + 22) === length, 'local/central metadata mismatch');
    extras(bytes.subarray(offset + 30 + localName, payload));
    if (method === 0) need(packed === length, 'stored size mismatch');
    entries.push({ name, method, crc32, packed, size: length, payload, end: payload + packed, offset });
    at += 46 + nameLength + extraLength;
  }
  need(at === end, 'central directory length/count mismatch');
  const ordered = [...entries].sort((a, b) => a.offset - b.offset);
  need(ordered[0].offset === 0, 'unexpected archive prefix');
  for (let i = 0; i < ordered.length; i++) need(ordered[i].end === (ordered[i + 1]?.offset ?? start), 'overlapping or unaccounted payload bytes');
  for (const [name, expected] of Object.entries(required)) {
    const entry = entries.find(e => e.name === name); need(entry, 'required entry missing: ' + name);
    if (expected !== null) need(entry.size === expected, 'required entry size mismatch: ' + name);
  }
  return { entries, expanded };
}

// Pinned libzip output: one ordinary Zstd frame, no external dictionary.
// Check framing independently: older Node decoders can accept a missing final
// checksum even when decoded size and ZIP CRC happen to match.
function zstdFrame(bytes: Buffer, expectedSize: number) {
  need(bytes.length >= 6 && bytes.readUInt32LE(0) === 0xfd2fb528, 'expected a single Zstandard frame');
  const descriptor = bytes[4], single = !!(descriptor & 32), fcsSize = [single ? 1 : 0, 2, 4, 8][descriptor >> 6];
  need((descriptor & 0x1b) === 0, 'unsupported Zstandard dictionary/reserved fields');
  let at = 5, window = expectedSize;
  if (!single) {
    const value = bytes[at++], base = 2 ** (10 + (value >> 3)); window = base + base / 8 * (value & 7);
    need(window <= 2 ** inputStateLimits.zstd_window_log, 'Zstandard window budget exceeded');
  }
  need(at + fcsSize <= bytes.length, 'truncated Zstandard frame header');
  if (fcsSize) {
    const size = fcsSize === 8 ? bytes.readBigUInt64LE(at) : BigInt(bytes.readUIntLE(at, fcsSize) + (fcsSize === 2 ? 256 : 0));
    need(size === BigInt(expectedSize), 'Zstandard content size differs from ZIP'); at += fcsSize;
  }
  let last = false, count = 0;
  while (!last) {
    need(++count <= 16384 && at + 3 <= bytes.length, 'truncated/excessive Zstandard blocks');
    const header = bytes.readUIntLE(at, 3), type = (header >> 1) & 3, size = header >>> 3;
    last = !!(header & 1); at += 3;
    need(type !== 3 && size <= Math.min(window, 131072), 'invalid Zstandard block type/size');
    at += type === 1 ? 1 : size; need(at <= bytes.length, 'truncated Zstandard block payload');
  }
  need(at + (descriptor & 4 ? 4 : 0) === bytes.length, 'truncated/trailing Zstandard frame checksum or bytes');
}

async function verifyPayload(bytes: Buffer, entry: Entry, signal?: AbortSignal) {
  signal?.throwIfAborted();
  need(typeof zlib.crc32 === 'function', 'CRC verification requires Node 22.15+');
  const payload = bytes.subarray(entry.payload, entry.end); let count = 0, crc = 0;
  const version = entry.name === 'PCSX2 Savestate Version.id' ? Buffer.alloc(36) : undefined;
  const sink = new Writable({ write(chunk: Buffer, _encoding, done) {
    try {
      signal?.throwIfAborted(); need(count + chunk.length <= entry.size, 'decoded size exceeds declared bound: ' + entry.name);
      if (version) chunk.copy(version, count); count += chunk.length; crc = zlib.crc32(chunk, crc); done();
    } catch (error) { done(error as Error); }
  } });
  if (entry.method === 0) await pipeline(Readable.from([payload]), sink, { signal });
  else {
    if (entry.method === 93) need(typeof zlib.createZstdDecompress === 'function', 'Zstandard companions require Node 22.15+');
    if (entry.method === 93) zstdFrame(payload, entry.size);
    const decoder = entry.method === 8 ? zlib.createInflateRaw() : zlib.createZstdDecompress({ params: { [zlib.constants.ZSTD_d_windowLogMax]: inputStateLimits.zstd_window_log } });
    await pipeline(Readable.from([payload]), decoder, sink, { signal });
    need(decoder.bytesWritten === payload.length, 'trailing or partially consumed compressed input: ' + entry.name);
  }
  need(count === entry.size && crc === entry.crc32, 'decoded length/CRC mismatch: ' + entry.name);
  return version;
}

export async function parseInputState(bytes: Buffer, signal?: AbortSignal) {
  const { entries, expanded } = directory(bytes);
  const version = await verifyPayload(bytes, entries.find(e => e.name === 'PCSX2 Savestate Version.id')!, signal);
  need(version && version.readUInt32LE(0) === VERSION, 'version header does not match pinned PCSX2 v2.9.147');
  const tag = version.subarray(4), end = tag.indexOf(0); need(end >= 0, 'unterminated producer tag');
  need(tag.subarray(0, end).every(b => b >= 32 && b <= 126), 'invalid producer tag');
  for (const entry of entries) if (entry.name !== 'PCSX2 Savestate Version.id') await verifyPayload(bytes, entry, signal);
  return { format: 'pcsx2_zip32' as const, pinned_version: 'v2.9.147' as const, save_version: '0x' + VERSION.toString(16),
    producer_reported: tag.subarray(0, end).toString('ascii'), expanded_bytes: expanded,
    entries: entries.map(e => ({ name: e.name, compression: e.method, bytes: e.size, packed_bytes: e.packed, crc32: e.crc32.toString(16).padStart(8, '0') })),
    archive_and_payloads_verified: true, native_load: 'not_performed', elf_association: 'not_verified', determinism: 'not_established', limits: inputStateLimits };
}

export async function inspectInputState(input: z.input<typeof inputStateOptions>, signal?: AbortSignal) {
  const options = inputStateOptions.parse(input), bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(inputStateLimits.deadline_ms)]) : AbortSignal.timeout(inputStateLimits.deadline_ms);
  bounded.throwIfAborted();
  const before = await stat(options.path, { bigint: true });
  const file = await hashLocalFile(options.path, inputStateLimits.archive_bytes, bounded);
  if (options.expected_sha256 && file.sha256 !== options.expected_sha256.toLowerCase()) throw new Error('Companion SHA256 mismatch');
  const result = await parseInputState(file.bytes, bounded); bounded.throwIfAborted();
  const after = await stat(options.path, { bigint: true });
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const)
    if (before[key] !== after[key]) throw new Error('Companion changed during payload verification');
  return { path: options.path, sha256: file.sha256, bytes: file.bytes.length, ...result };
}
