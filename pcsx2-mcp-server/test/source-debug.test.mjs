import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SourceResolver, inspectSourceElf, parseSourceOutput, runSourceTool } from '../dist/source-debug.js';

// Structural ELF fixture only. Genuine compiler-generated DWARF is exercised in source-live.mjs.
async function fixture(t, debug = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcsx2 source á-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'test.elf');
  const bytes = Buffer.alloc(512);
  bytes.set(Buffer.from('7f454c4601010100', 'hex'));
  bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(8, 18); bytes.writeUInt32LE(1, 20);
  bytes.writeUInt32LE(0x100000, 24); bytes.writeUInt32LE(52, 28); bytes.writeUInt32LE(128, 32);
  bytes.writeUInt16LE(52, 40); bytes.writeUInt16LE(32, 42); bytes.writeUInt16LE(1, 44);
  bytes.writeUInt16LE(40, 46); bytes.writeUInt16LE(3, 48); bytes.writeUInt16LE(1, 50);
  bytes.writeUInt32LE(1, 52); bytes.writeUInt32LE(0x100000, 60); bytes.writeUInt32LE(32, 68);
  bytes.writeUInt32LE(32, 72); bytes.writeUInt32LE(5, 76);
  bytes.writeUInt32LE(1, 168); bytes.writeUInt32LE(3, 172); bytes.writeUInt32LE(300, 184); bytes.writeUInt32LE(40, 188);
  bytes.writeUInt32LE(11, 208); bytes.writeUInt32LE(1, 212); bytes.writeUInt32LE(350, 224); bytes.writeUInt32LE(debug ? 16 : 0, 228);
  Buffer.from('\0.shstrtab\0.debug_line\0').copy(bytes, 300);
  await fs.writeFile(filename, bytes);
  return { filename, bytes };
}

test('source output preserves Windows paths, inline order, columns, unknowns and discriminators', () => {
  const result = parseSourceOutput('0x00100000\ninline_fn(int)\nC:\\src dir\\main.cpp:17 (discriminator 2)\nouter\n/home/user/main.cpp:30:4\n0x00100004\n??\n??:0\n', ['100000', '100004']);
  assert.equal(result[0].frames[0].file, 'C:\\src dir\\main.cpp');
  assert.equal(result[0].frames[0].line, 17);
  assert.equal(result[0].frames[0].discriminator, 2);
  assert.equal(result[0].frames[1].column, 4);
  assert.equal(result[1].resolved, false); assert.equal(result[1].frames[0].line, null);
  assert.throws(() => parseSourceOutput('0x00100008\nf\na.c:1\n', ['100000']), /marker/);
  assert.throws(() => parseSourceOutput('0x00100000\nf\ninvalid\n', ['100000']), /Malformed/);
  assert.throws(() => parseSourceOutput('0x00100000\nf\na.c:1\n0x00100004\nf\na.c:2\n', ['100000']), /trailing/);
});

test('ELF validation reads load ranges and CRC, rejects corrupt extents and non-executables', async t => {
  const { filename, bytes } = await fixture(t);
  const elf = await inspectSourceElf(filename);
  assert.equal(elf.has_debug_lines, true); assert.equal(elf.entry, '0x00100000');
  assert.deepEqual(elf.executable_ranges, [{ start: 0x100000, end: 0x100020 }]);
  let crc = 0; for (let i = 0; i + 4 <= bytes.length; i += 4) crc ^= bytes.readUInt32LE(i);
  assert.equal(elf.elf_crc, '0x' + (crc >>> 0).toString(16).padStart(8, '0'));
  bytes.writeUInt32LE(0xfffffff0, 32); await fs.writeFile(filename, bytes);
  await assert.rejects(inspectSourceElf(filename), /beyond/);
  bytes.writeUInt16LE(1, 16); await fs.writeFile(filename, bytes);
  await assert.rejects(inspectSourceElf(filename), /ET_EXEC/);
});

test('offline source lookup deduplicates work, guards SHA256 and never spawns for stripped/outside addresses', async t => {
  const { filename } = await fixture(t); let calls = 0;
  const resolver = new SourceResolver({ backend: 'native', runner: async (command, args) => {
    calls++; assert.deepEqual(args.slice(-1), ['0x00100000']);
    assert.equal(args[args.indexOf('-e') + 1], filename);
    return '0x00100000\n_start\n/build/source.c:2\n';
  } });
  const result = await resolver.resolve({ elf: filename, addresses: ['100000', '00100000', '40000000'] });
  assert.equal(calls, 1); assert.equal(result.locations.length, 3);
  assert.equal(result.locations[0].frames[0].line, 2);
  assert.equal(result.locations[2].reason, 'outside_executable_segments');
  await assert.rejects(resolver.resolve({ elf: filename, addresses: ['100000'], expected_sha256: '0'.repeat(64) }), /SHA256/);
  await assert.rejects(resolver.resolve({ elf: filename, addresses: ['100000'] }, undefined, 'ffffffff'), /CRC/);
  assert.equal(calls, 1);
  const stripped = await fixture(t, false);
  const unknown = await resolver.resolve({ elf: stripped.filename, addresses: ['100000'] });
  assert.equal(unknown.locations[0].reason, 'no_debug_line_section'); assert.equal(calls, 1);
  await assert.rejects(resolver.resolve({ elf: filename, addresses: ['0x100000000'] }));
});

test('Windows fallback translates paths using argument arrays and bounds the WSL worker', async t => {
  const { filename } = await fixture(t); const calls = [];
  const resolver = new SourceResolver({ platform: 'win32', runner: async (command, args) => {
    calls.push({ command, args });
    if (command !== 'wsl.exe') throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    if (args.includes('wslpath')) return '/mnt/d/source dir/test.elf\n';
    assert.ok(args.includes('timeout')); assert.ok(args.includes('8s'));
    assert.ok(args.includes('/mnt/d/source dir/test.elf'));
    return '0x00100000\n_start\n/source dir/main.c:2\n';
  } });
  assert.equal((await resolver.resolve({ elf: filename, addresses: ['100000'] })).tool.backend, 'wsl');
  assert.equal(calls.length, 5);
  const failed = new SourceResolver({ platform: 'win32', runner: async () => { throw new Error('invalid debug data'); } });
  await assert.rejects(failed.resolve({ elf: filename, addresses: ['100000'] }), /invalid debug data/);
});

test('source lookup rejects ELF mutation while the tool runs', async t => {
  const { filename, bytes } = await fixture(t);
  const resolver = new SourceResolver({ runner: async () => {
    await fs.appendFile(filename, Buffer.from([0]));
    return '0x00100000\n_start\nmain.c:2\n';
  } });
  await assert.rejects(resolver.resolve({ elf: filename, addresses: ['100000'] }), /changed/);
  assert.ok(bytes.length);
});

test('PC lookup guards running identity and does not pause or write to the VM', async t => {
  const { filename } = await fixture(t); const elf = await inspectSourceElf(filename);
  const resolver = new SourceResolver({ runner: async () => '0x00100000\n_start\nmain.c:2\n' });
  let changed = false; let reads = 0;
  const client = {
    withExclusiveSession: operation => operation(),
    getCapabilities: async () => ({ process_id: 12, session: ++reads > 1 && changed ? 2 : 1, elf: 'host:' + filename, elf_crc: elf.elf_crc }),
    getStatus: async () => ({ pc: '0x00100000', paused: true }),
  };
  assert.equal((await resolver.currentPc(client)).locations[0].resolved, true);
  reads = 0; changed = true;
  await assert.rejects(resolver.currentPc(client), /identity changed/);
  reads = 0; changed = false; client.getCapabilities = async () => ({ elf: filename, elf_crc: '0xdeadbeef' });
  await assert.rejects(resolver.currentPc(client), /CRC/);
});

test('source subprocess rejects failures, excessive output, cancellation and timeout', async () => {
  const opts = { timeoutMs: 5000 };
  assert.equal(await runSourceTool(process.execPath, ['-e', 'process.stdout.write("á test")'], opts), 'á test');
  await assert.rejects(runSourceTool(process.execPath, ['-e', 'process.stderr.write("bad DWARF"); process.exit(1)'], opts), /bad DWARF/);
  await assert.rejects(runSourceTool(process.execPath, ['-e', 'process.stdout.write("x".repeat(1100000))'], opts), /1 MiB/);
  await assert.rejects(runSourceTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), /timed out/);
  const abort = new AbortController();
  const pending = runSourceTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 5000, signal: abort.signal });
  abort.abort(); await assert.rejects(pending, /cancelled/);
});
