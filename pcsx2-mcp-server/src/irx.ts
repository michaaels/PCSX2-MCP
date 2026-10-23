import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const hex = (v: number) => '0x' + v.toString(16).padStart(8, '0');
const signature = (s: Awaited<ReturnType<fs.FileHandle['stat']>>) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
type Section = { name: string; type: number; flags: number; address: number; offset: number; size: number; info: number; entsize: number };
type Relocation = { offset: number; type: number; symbol: number };

// A deliberately narrow IRX dialect. Unsupported layouts/relocations fail closed.
// Loader semantics reference: ps2sdk 89b9d8cf249f927192c57804ce5e55e99e34002d,
// iop/system/loadcore/src/loadcore.c (independent implementation, no copied code).
export function parseIrx(bytes: Buffer) {
  if (bytes.length < 52 || bytes.length > 32 * 1024 * 1024 || bytes.toString('hex', 0, 7) !== '7f454c46010101' ||
      bytes.readUInt16LE(16) !== 0xff80 || bytes.readUInt16LE(18) !== 8 || bytes.readUInt32LE(20) !== 1 ||
      bytes.readUInt16LE(40) !== 52) throw new Error('Expected ELF32 little-endian MIPS ET_SCE_IOPRELEXEC (0xff80)');
  const extent = (offset: number, size: number) => {
    if (offset + size > bytes.length) throw new Error('IRX extent outside file');
  };
  const phoff = bytes.readUInt32LE(28), shoff = bytes.readUInt32LE(32), shnum = bytes.readUInt16LE(48), namesIndex = bytes.readUInt16LE(50);
  if (bytes.readUInt16LE(42) !== 32 || bytes.readUInt16LE(44) !== 2 || bytes.readUInt16LE(46) !== 40 ||
      shnum < 2 || shnum > 1024 || !namesIndex || namesIndex >= shnum) throw new Error('Unsupported IRX tables');
  extent(phoff, 64); extent(shoff, shnum * 40);
  if (bytes.readUInt32LE(phoff) !== 0x70000080 || bytes.readUInt32LE(phoff + 32) !== 1)
    throw new Error('Expected IOPMOD followed by one PT_LOAD');
  const modOffset = bytes.readUInt32LE(phoff + 4), modSize = bytes.readUInt32LE(phoff + 16);
  const load = phoff + 32, offset = bytes.readUInt32LE(load + 4), fileSize = bytes.readUInt32LE(load + 16), memSize = bytes.readUInt32LE(load + 20);
  extent(modOffset, modSize); extent(offset, fileSize);
  if (modSize < 27 || modSize > 154 || bytes.readUInt32LE(load + 8) !== 0 || bytes.readUInt32LE(load + 12) !== 0 ||
      fileSize < 64 || fileSize > 256 * 1024 || memSize < fileSize || memSize > 0x200000) throw new Error('Unsupported IRX load layout/bounds');
  const textSize = bytes.readUInt32LE(modOffset + 12), dataSize = bytes.readUInt32LE(modOffset + 16), bssSize = bytes.readUInt32LE(modOffset + 20);
  const entry = bytes.readUInt32LE(modOffset + 4), gp = bytes.readUInt32LE(modOffset + 8);
  const nameEnd = bytes.indexOf(0, modOffset + 26);
  if (nameEnd < 0 || nameEnd >= modOffset + modSize || nameEnd - modOffset - 26 > 127 || !textSize || textSize % 4 ||
      textSize + dataSize !== fileSize || fileSize + bssSize !== memSize || entry % 4 || entry >= textSize || bytes.readUInt32LE(24) !== entry)
    throw new Error('Inconsistent IOPMOD/load metadata');
  const name = bytes.toString('latin1', modOffset + 26, nameEnd);
  if (!/^[\x20-\x7e]+$/.test(name)) throw new Error('Unsupported IOPMOD name');
  const namesHeader = shoff + namesIndex * 40, namesOffset = bytes.readUInt32LE(namesHeader + 16), namesSize = bytes.readUInt32LE(namesHeader + 20);
  extent(namesOffset, namesSize); const names = bytes.subarray(namesOffset, namesOffset + namesSize);
  const sections: Section[] = [];
  for (let i = 0; i < shnum; i++) {
    const p = shoff + i * 40, n = bytes.readUInt32LE(p), end = names.indexOf(0, n);
    if (n >= namesSize || end < 0) throw new Error('Invalid IRX section name');
    const s = { name: names.toString('utf8', n, end), type: bytes.readUInt32LE(p + 4), flags: bytes.readUInt32LE(p + 8),
      address: bytes.readUInt32LE(p + 12), offset: bytes.readUInt32LE(p + 16), size: bytes.readUInt32LE(p + 20),
      info: bytes.readUInt32LE(p + 28), entsize: bytes.readUInt32LE(p + 36) };
    if (s.type !== 8) extent(s.offset, s.size);
    if (s.flags & 2) {
      if ((s.type !== 1 && s.type !== 8) || s.flags & ~7 || s.address + s.size > memSize ||
          (s.type === 1 && (s.offset !== offset + s.address || s.address + s.size > fileSize)) ||
          (s.type === 8 && s.address < fileSize) || ((s.flags & 4) && ((s.flags & 1) || s.address + s.size > textSize)))
        throw new Error('Unsupported allocated IRX section');
    }
    if (s.type === 4) throw new Error('IRX RELA relocations unsupported');
    sections.push(s);
  }
  const allocated = sections.filter(s => (s.flags & 2) && s.size).sort((a, b) => a.address - b.address);
  for (let i = 1; i < allocated.length; i++) if (allocated[i].address < allocated[i - 1].address + allocated[i - 1].size)
    throw new Error('Overlapping IRX allocated sections');
  const executable = allocated.filter(s => s.flags & 4).map(s => ({ start: s.address, end: s.address + s.size }));
  if (!executable.some(s => entry >= s.start && entry < s.end)) throw new Error('IRX entry outside executable sections');
  const relocationGroups: Relocation[][] = []; let relocationCount = 0, debugRelocationCount = 0; const targets = new Set<number>();
  for (const s of sections.filter(s => s.type === 9)) {
    const target = sections[s.info];
    if (s.entsize !== 8 || s.size % 8 || !target) throw new Error('Unsupported IRX relocation section');
    if (!(target.flags & 2)) {
      if (!target.name.startsWith('.debug_')) throw new Error('Unsupported nonallocated IRX relocation target');
      debugRelocationCount += s.size / 8;
      if (debugRelocationCount > 65536) throw new Error('IRX debug relocation budget exceeded');
      continue; // Legacy debug companion only; never apply file-only DWARF relocations to guest RAM.
    }
    relocationCount += s.size / 8; if (relocationCount > 65536) throw new Error('IRX relocation budget exceeded');
    const group: Relocation[] = [];
    for (let p = s.offset; p < s.offset + s.size; p += 8) {
      const address = bytes.readUInt32LE(p), info = bytes.readUInt32LE(p + 4), type = info & 255;
      if (![0, 1, 2, 4, 5, 6].includes(type)) throw new Error(`Unsupported IRX relocation type ${type}`);
      if (address % 4 || address < target.address || address + 4 > target.address + target.size || address + 4 > fileSize || targets.has(address))
        throw new Error('Invalid/duplicate IRX relocation target');
      targets.add(address); group.push({ offset: address, type, symbol: info >>> 8 });
    }
    for (let i = 0; i < group.length; i++) if (group[i].type === 5 &&
      (group[i + 1]?.type !== 6 || group[i + 1].symbol !== group[i].symbol)) throw new Error('IRX HI16 requires an adjacent matching LO16');
    relocationGroups.push(group);
  }
  const compressed = sections.some(s => (s.name === '.zdebug_line' || (s.name === '.debug_line' && (s.flags & 0x800))) && s.size > 0);
  const hasLines = sections.some(s => s.name === '.debug_line' && s.size > 0 && !(s.flags & 0x800));
  return { bytes, image: bytes.subarray(offset, offset + fileSize), textSize, dataSize, bssSize, memSize, entry, gp,
    name, version: bytes.readUInt16LE(modOffset + 24), modId: bytes.readUInt32LE(modOffset),
    moduleInfo: bytes.subarray(modOffset, modOffset + modSize), sections, executable, relocationGroups, relocationCount, debugRelocationCount,
    has_debug_lines: hasLines, debug_line_status: compressed ? 'compressed_unsupported' : hasLines ? 'available' : 'absent' };
}
export async function inspectIrx(filename: string) {
  if (!path.isAbsolute(filename) || /[\x00-\x1f]/.test(filename)) throw new Error('IRX path must be absolute without control characters');
  const irx = await fs.realpath(filename), file = await fs.open(irx, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 52 || before.size > 32 * 1024 * 1024) throw new Error('IRX file must be 52 bytes to 32 MiB');
    const bytes = Buffer.alloc(before.size);
    for (let offset = 0; offset < bytes.length;) {
      const read = await file.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (!read.bytesRead) throw new Error('IRX changed or truncated while reading');
      offset += read.bytesRead;
    }
    if (signature(before) !== signature(await file.stat()) || bytes.length !== before.size) throw new Error('IRX changed while reading');
    return { ...parseIrx(bytes), irx, sha256: hash(bytes), file_version: signature(before) };
  } finally { await file.close(); }
}
export function relocateIrx(irx: ReturnType<typeof parseIrx>, base: number) {
  if (!Number.isInteger(base) || base < 0 || base % 4 || base + irx.memSize > 0x200000) throw new Error('IRX load bias outside canonical RAM');
  const expected = Buffer.from(irx.image), counts: Record<number, number> = {};
  for (const group of irx.relocationGroups) for (let i = 0; i < group.length; i++) {
    const r = group[i], word = expected.readUInt32LE(r.offset); counts[r.type] = (counts[r.type] ?? 0) + 1;
    let value = word;
    if (r.type === 1 || r.type === 6) value = (word & 0xffff0000) | ((word + base) & 0xffff);
    if (r.type === 2) value = word + base;
    if (r.type === 4) {
      if (word >>> 26 !== 2 && word >>> 26 !== 3) throw new Error('IRX R_MIPS_26 target is not J/JAL');
      value = (word & 0xfc000000) | (((word & 0x03ffffff) + base / 4) & 0x03ffffff);
    }
    if (r.type === 5) {
      if (word >>> 26 !== 15) throw new Error('IRX HI16 target is not LUI');
      const low = expected.readInt16LE(group[i + 1].offset);
      const address = (base + (word & 0xffff) * 65536 + low) >>> 0;
      value = (word & 0xffff0000) | (((address + 0x8000) >>> 16) & 0xffff);
    }
    expected.writeUInt32LE(value >>> 0, r.offset);
  }
  return { expected, counts };
}

export function verifyIrxImage(irx: ReturnType<typeof parseIrx>, module: {
  name: string | null; version: number; text_address: string; text_size: number; data_size: number; bss_size: number; entry: string; gp: string;
}, actual: Buffer) {
  const base = Number(module.text_address);
  if (module.name !== irx.name || module.version !== irx.version || module.text_size !== irx.textSize ||
      module.data_size !== irx.dataSize || module.bss_size !== irx.bssSize || Number(module.entry) !== base + irx.entry ||
      Number(module.gp) !== ((base + irx.gp) >>> 0) || actual.length !== irx.image.length) throw new Error('IRX/runtime module metadata mismatch');
  const { expected, counts } = relocateIrx(irx, base), mask = Buffer.alloc(expected.length);
  mask.fill(255, 0, irx.textSize);
  for (const s of irx.sections) if (s.type === 1 && (s.flags & 2) && !(s.flags & 1)) mask.fill(255, s.address, s.address + s.size);
  const imports: { start: number; end: number; library: string; stubs: number }[] = [];
  for (let at = 0; at + 4 <= irx.textSize; at += 4) {
    if (expected.readUInt32LE(at) !== 0x41e00000) continue;
    if (imports.length >= 128 || at + 28 > irx.textSize || expected.readUInt32LE(at + 4) !== 0 || expected.readUInt16LE(at + 10) !== 0)
      throw new Error('Unsupported IRX import header');
    const name = expected.subarray(at + 12, at + 20), library = name.toString('latin1').replace(/\0+$/, '');
    if (!/^[\x21-\x7e]{1,8}$/.test(library)) throw new Error('Unsupported IRX import name');
    const next = actual.readUInt32LE(at + 4), mode = actual.readUInt16LE(at + 10);
    if (next && (next % 4 || next >= 0x200000) || (mode !== 0 && mode !== 2)) throw new Error('Unsupported runtime import linkage');
    mask.fill(0, at + 4, at + 8); mask[at + 10] = 0xf9;
    let end = at + 20, stubs = 0;
    for (;;) {
      if (end + 8 > irx.textSize || stubs > 4096) throw new Error('IRX import stub bound exceeded');
      const first = expected.readUInt32LE(end), second = expected.readUInt32LE(end + 4);
      if (!first && !second) { end += 8; break; }
      if (first !== 0x03e00008 || (second & 0xffff0000) !== 0x24000000) throw new Error('Unsupported IRX import stub');
      const runtime = actual.readUInt32LE(end), target = (runtime & 0x03ffffff) * 4;
      if (runtime !== first && (runtime >>> 26 !== 2 || !target || target >= 0x200000)) throw new Error('Invalid runtime import jump');
      mask.fill(0, end, end + 4); stubs++; end += 8;
    }
    if (!stubs) throw new Error('Empty IRX import table');
    for (const group of irx.relocationGroups) if (group.some(r => r.offset >= at && r.offset < end))
      throw new Error('Relocations inside import tables unsupported');
    imports.push({ start: at, end, library, stubs }); at = end - 4;
  }
  const exports: { start: number; end: number; library: string; functions: number }[] = [];
  for (let at = 0; at + 4 <= irx.textSize; at += 4) {
    if (expected.readUInt32LE(at) !== 0x41c00000 || imports.some(r => at >= r.start && at < r.end)) continue;
    if (exports.length >= 128 || at + 24 > irx.textSize || expected.readUInt32LE(at + 4) !== 0 || expected.readUInt16LE(at + 10) !== 0)
      throw new Error('Unsupported IRX export header');
    const library = expected.subarray(at + 12, at + 20).toString('latin1').replace(/\0+$/, '');
    if (!/^[\x21-\x7e]{1,8}$/.test(library)) throw new Error('Unsupported IRX export library');
    const previous = actual.readUInt32LE(at), caller = actual.readUInt32LE(at + 4);
    if ((previous !== 0x41c00000 && previous && (previous % 4 || previous >= 0x200000)) ||
        (caller && (caller % 4 || caller >= 0x200000))) throw new Error('Invalid runtime export linkage');
    if (actual.readUInt16LE(at + 10) > 1) throw new Error('Unsupported runtime export flags');
    let end = at + 20, functions = 0;
    for (;;) {
      if (end + 4 > irx.textSize || functions > 4096) throw new Error('IRX export table bound exceeded');
      const target = expected.readUInt32LE(end); end += 4;
      if (!target) break;
      const linked = target - base;
      if (linked % 4 || !irx.executable.some(r => linked >= r.start && linked + 4 <= r.end)) throw new Error('Unsupported IRX export target');
      functions++;
    }
    if (!functions || imports.some(r => at < r.end && end > r.start)) throw new Error('Empty/overlapping IRX export table');
    const relocations = irx.relocationGroups.flat().filter(r => r.offset >= at && r.offset < end);
    if (relocations.length !== functions || relocations.some(r => r.type !== 2 || r.offset < at + 20 || r.offset >= end - 4))
      throw new Error('Unsupported IRX export relocations');
    // Only list links/mode bits are mutable. Every relocated function pointer
    // remains compared; the table itself is never executable source evidence.
    mask.fill(0, at, at + 8); mask[at + 10] = 0xfe;
    exports.push({ start: at, end, library, functions }); at = end - 4;
  }
  const executableMask = Buffer.alloc(expected.length);
  for (const r of irx.executable) executableMask.fill(1, r.start, r.end);
  for (const r of imports) executableMask.fill(0, r.start, r.end);
  for (const r of exports) executableMask.fill(0, r.start, r.end);
  const left = Buffer.alloc(expected.length), right = Buffer.alloc(expected.length); let compared = 0, code = 0;
  for (let i = 0; i < expected.length; i++) {
    left[i] = expected[i] & mask[i]; right[i] = actual[i] & mask[i];
    if (mask[i]) compared++;
    if (mask[i] === 255 && executableMask[i]) code++;
    if (left[i] !== right[i]) throw new Error(`Relocated IRX bytes mismatch at runtime ${hex(base + i)}`);
  }
  if (code < 64) throw new Error('Too few immutable code bytes for IRX verification');
  return { status: 'matched_relocated_readonly_image' as const, load_bias: hex(base), compared_bytes: compared,
    compared_executable_bytes_excluding_imports: code, image_bytes: actual.length, relocation_count: irx.relocationCount, relocations: counts,
    debug_relocations_not_loaded: irx.debugRelocationCount,
    normalized_readonly_sha256: hash(left), loader_mutable_bytes: mask.subarray(0, irx.textSize).filter(v => v !== 255).length,
    uncompared_bytes: expected.length - compared,
    writable_bytes_not_verified: irx.sections.filter(s => s.type === 1 && (s.flags & 3) === 3).reduce((n, s) => n + s.size, 0), bss_bytes_not_verified: irx.bssSize,
    imports: imports.map(i => ({ library: i.library, start: hex(base + i.start), end: hex(base + i.end), stubs: i.stubs })),
    exports: exports.map(i => ({ library: i.library, start: hex(base + i.start), end: hex(base + i.end), functions: i.functions })),
    import_targets_verified: false as const, module_generation: null, original_loaded_file_sha256: null,
    eligible: (linked: number) => Number.isInteger(linked) && linked % 4 === 0 && irx.executable.some(r => linked >= r.start && linked + 4 <= r.end) &&
      !imports.some(r => linked < r.end && linked + 4 > r.start) && !exports.some(r => linked < r.end && linked + 4 > r.start) };
}
