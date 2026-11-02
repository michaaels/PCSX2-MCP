import { crc32, deflateRawSync, zstdCompressSync } from 'node:zlib';

// Structural archive fixtures; these are deliberately not native-loadable RAM.
export function stateEntries() {
  const version = Buffer.alloc(36); version.writeUInt32LE(0x9a590000); version.write('v2.9.147', 4);
  return [
    { name: 'PCSX2 Savestate Version.id', data: version },
    ...Object.entries({ 'PCSX2 Internal Structures.dat': 16, 'eeMemory.bin': 33554432, 'iopMemory.bin': 2097152,
      'eeHwRegs.bin': 65536, 'iopHwRegs.bin': 65536, 'Scratchpad.bin': 16384, 'vu0Memory.bin': 4096, 'vu1Memory.bin': 16384,
      'vu0MicroMem.bin': 4096, 'vu1MicroMem.bin': 16384, 'SPU2.bin': 16, 'USB.bin': 16, 'PAD.bin': 16, 'GS.bin': 16 })
      .map(([name, size]) => ({ name, data: Buffer.alloc(size), method: 8 })),
  ];
}
export function stateZip(entries = stateEntries()) {
  const locals = [], central = []; let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 0, data = entry.data, payload = entry.payload ?? (method === 0 ? data : method === 8 ? deflateRawSync(data) : zstdCompressSync(data));
    const name = Buffer.from(entry.name), crc = entry.crc ?? crc32(data), flags = entry.flags ?? 0;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6); header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(payload.length, 18); header.writeUInt32LE(entry.size ?? data.length, 22); header.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(flags, 8); dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(payload.length, 20); dir.writeUInt32LE(entry.size ?? data.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    locals.push(header, name, payload); central.push(dir, name); offset += header.length + name.length + payload.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
