import { parseIrx, relocateIrx } from '../dist/irx.js';
import { capabilities } from './workflow-fixtures.mjs';
export const hex = n => '0x' + n.toString(16).padStart(8, '0');
export function irxFixture(debug = true) {
  const b = Buffer.alloc(4096), load = 176, imageSize = 160;
  b.write('7f454c46010101', 0, 'hex'); b.writeUInt16LE(0xff80, 16); b.writeUInt16LE(8, 18);
  b.writeUInt32LE(1, 20); b.writeUInt32LE(64, 24); b.writeUInt32LE(52, 28); b.writeUInt16LE(52, 40);
  b.writeUInt16LE(32, 42); b.writeUInt16LE(2, 44); b.writeUInt16LE(40, 46);
  const program = (p, values) => values.forEach((n, i) => b.writeUInt32LE(n, p + i * 4));
  program(52, [0x70000080, 116, 0, 0, 34, 34, 4, 4]);
  program(84, [1, load, 0, 0, imageSize, imageSize + 16, 7, 16]);
  program(116, [144, 64, 0x8000, 128, 32, 16]); b.writeUInt16LE(0x101, 140); b.write('fixture\0', 142);
  b.writeUInt32LE(0x41e00000, load); b.writeUInt16LE(0x101, load + 8); b.write('thbase', load + 12);
  b.writeUInt32LE(0x03e00008, load + 20); b.writeUInt32LE(0x24000004, load + 24);
  b.writeUInt32LE(0x0c000010, load + 64); b.writeUInt32LE(0x3c080000, load + 68); b.writeUInt32LE(0x25080080, load + 72);
  b.write('fixture-data', load + 128); b.writeUInt32LE(128, load + 144);
  let cursor = load + imageSize;
  const sections = [null,
    ['.iopmod', 0x70000080, 0, 0, 116, 34, 0, 0], ['.text', 1, 6, 0, load, 128, 0, 0],
    ['.rel.text', 9, 0, 0, cursor, 24, 2, 8]];
  for (const [i, off, type] of [[0, 64, 4], [1, 68, 5], [2, 72, 6]]) {
    b.writeUInt32LE(off, cursor + i * 8); b.writeUInt32LE(0x100 | type, cursor + i * 8 + 4);
  }
  cursor += 24;
  sections.push(['.rodata', 1, 2, 128, load + 128, 16, 0, 0], ['.data', 1, 3, 144, load + 144, 16, 0, 0],
    ['.rel.data', 9, 0, 0, cursor, 8, 5, 8], ['.bss', 8, 3, 160, load + 160, 16, 0, 0]);
  b.writeUInt32LE(144, cursor); b.writeUInt32LE(0x102, cursor + 4); cursor += 8;
  if (debug) { sections.push(['.debug_line', 1, 0, 0, cursor, 4, 0, 0]); cursor += 4; }
  const strings = Buffer.from('\0' + [...sections.slice(1).map(s => s[0]), '.shstrtab'].join('\0') + '\0');
  const namesIndex = sections.length; sections.push(['.shstrtab', 3, 0, 0, cursor, strings.length, 0, 0]);
  strings.copy(b, cursor); cursor += strings.length; cursor = (cursor + 3) & ~3;
  const shoff = cursor; b.writeUInt32LE(shoff, 32); b.writeUInt16LE(sections.length, 48); b.writeUInt16LE(namesIndex, 50);
  const headers = {};
  sections.forEach((s, i) => {
    if (!s) return;
    const [name, type, flags, addr, off, size, info, ent] = s, at = shoff + i * 40; headers[name] = at;
    program(at, [strings.indexOf(Buffer.from(name + '\0')), type, flags, addr, off, size, 0, info, 4, ent]);
  });
  return { bytes: b.subarray(0, shoff + sections.length * 40), headers, load };
}
export const caps = { ...capabilities, execution_epoch: 7, iop_reset_epoch: 3, features: ['iop_module_image'] };
export function runtime(bytes) {
  const irx = parseIrx(bytes), base = 0x2000;
  const module = { record_address: '0x00001000', next_address: '0x00000000', name_address: '0x00002080', name: irx.name,
    version: irx.version, entry: hex(base + irx.entry), gp: hex(base + irx.gp), text_address: hex(base),
    text_size: irx.textSize, data_size: irx.dataSize, bss_size: irx.bssSize };
  const actual = relocateIrx(irx, base).expected;
  actual.writeUInt16LE(2, 10); actual.writeUInt32LE(0x08000400, 20);
  const table = { ok: true, cpu: 'iop', snapshot_id: 1, timestamp_ms: 1000, session: 1, execution_epoch: 7,
    iop_reset_epoch: 3, iop_reset_scope: 'cpu_reset_only', revision: 9, elf: caps.elf, elf_crc: caps.elf_crc,
    elf_role: 'ee_boot_affinity_only', scope: 'paused_runtime_observation_only', source: 'pcsx2_detected_loadcore_list',
    root_discovery_sequence: 1, list_address: '0x00003000', head_address: module.record_address,
    status: 'observed', reason: null, modules: [module] };
  const image = { ...table, image_record: module.record_address, sample_pc: module.entry,
    module_image: { address: module.text_address, length: actual.length, valid: true, hex: actual.toString('hex') } };
  return { irx, module, actual, table, image };
}
