import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseIrx, relocateIrx, verifyIrxImage, inspectIrx } from '../dist/irx.js';
import { parseIopModuleImage } from '../dist/iop-modules.js';
import { inspectRuntimeIrx } from '../dist/irx-tools.js';
import { SourceResolver } from '../dist/source-debug.js';
import { workflowFixture } from './workflow-fixtures.mjs';
import { irxFixture, runtime, caps } from './irx-fixtures.mjs';

async function local(t, debug = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'irx-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixture = irxFixture(debug), irx = path.join(directory, 'fixture.irx'); await fs.writeFile(irx, fixture.bytes);
  return { ...fixture, ...runtime(fixture.bytes), irx };
}
test('IRX parser refuses wrong CPU/type, truncated/overlapping layouts and unsupported/malformed relocations', () => {
  const fixture = irxFixture(); assert.equal(parseIrx(fixture.bytes).relocationCount, 4);
  for (const mutate of [b => b.writeUInt16LE(2, 16), b => b[5] = 2, b => b.writeUInt16LE(0xff81, 16),
    b => b.writeUInt32LE(0xffffffff, 32), b => b.writeUInt32LE(1024 * 1024, 100),
    b => b.writeUInt32LE(20, fixture.headers['.rodata'] + 12),
    b => b.writeUInt32LE(7, fixture.load + 160 + 4), b => b.writeUInt32LE(4, fixture.load + 160 + 20),
    b => b.writeUInt32LE(2, fixture.load + 160), b => b.writeUInt32LE(68, fixture.load + 160 + 16)]) {
    const value = Buffer.from(fixture.bytes); mutate(value); assert.throws(() => parseIrx(value));
  }
  assert.throws(() => parseIrx(fixture.bytes.subarray(0, 100)));
});
test('relocation reconstruction verifies J/JAL, pointer and signed HI16/LO16 carry independently', () => {
  const f = irxFixture(), irx = parseIrx(f.bytes), r = relocateIrx(irx, 0x2000).expected;
  assert.equal(r.readUInt32LE(64), 0x0c000810); assert.equal(r.readUInt32LE(144), 0x2080);
  assert.equal(r.readUInt32LE(68), 0x3c080000); assert.equal(r.readUInt32LE(72), 0x25082080);
  f.bytes.writeUInt16LE(0x8000, f.load + 72);
  const carry = relocateIrx(parseIrx(f.bytes), 0x18000).expected;
  assert.equal(carry.readUInt32LE(68), 0x3c080001); assert.equal(carry.readUInt32LE(72), 0x25080000);
  assert.throws(() => relocateIrx(irx, 0x1ffff0)); assert.throws(() => relocateIrx(irx, 0x2001));
});
test('verification covers immutable code/rodata and bounds known imports without proving import targets, data or generation', () => {
  const f = irxFixture(), r = runtime(f.bytes), proof = verifyIrxImage(r.irx, r.module, r.actual);
  assert.equal(proof.status, 'matched_relocated_readonly_image'); assert.equal(proof.relocation_count, 4);
  assert.equal(proof.import_targets_verified, false); assert.equal(proof.module_generation, null);
  assert.equal(proof.original_loaded_file_sha256, null); assert.equal(proof.eligible(20), false); assert.equal(proof.eligible(64), true);
  const mutable = Buffer.from(r.actual); mutable.writeUInt32LE(0xdeadbeef, 144);
  assert.equal(verifyIrxImage(r.irx, r.module, mutable).normalized_readonly_sha256, proof.normalized_readonly_sha256);
  for (const mutate of [b => b[64] ^= 1, b => b[128] ^= 1, b => b[24] ^= 1,
    b => b.writeUInt32LE(0x10000000, 4), b => b.writeUInt32LE(0x0c000400, 20)]) {
    const value = Buffer.from(r.actual); mutate(value); assert.throws(() => verifyIrxImage(r.irx, r.module, value));
  }
  assert.throws(() => verifyIrxImage(r.irx, { ...r.module, entry: '0x00002044' }, r.actual));
});
test('module images require exact canonical extent, selected record, readable bytes and nonoverlapping module ranges', () => {
  const { image } = runtime(irxFixture().bytes); parseIopModuleImage(image);
  for (const mutate of [s => s.module_image.valid = false, s => s.module_image.hex = 'ff',
    s => s.module_image.address = '0x10000000', s => s.image_record = '0x00001004',
    s => { s.modules.push({ ...s.modules[0], record_address: '0x00001040' }); s.modules[0].next_address = '0x00001040'; }]) {
    const value = structuredClone(image); mutate(value); assert.throws(() => parseIopModuleImage(value));
  }
});
test('guarded IRX source uses relocated IOP addresses, hashes selected artifact and performs only read commands', async t => {
  const f = await local(t); let images = 0;
  const { client, mock } = await workflowFixture(t, r => {
    if (r.cmd === 'capabilities') return caps;
    if (r.cmd === 'iop_module_snapshot') return f.table;
    if (r.cmd === 'iop_module_image') { images++; assert.equal(r.expected_revision, 9); return f.image; }
  });
  const resolver = { resolveIrx: async (file, sha, addresses) => {
    assert.equal(file, f.irx); assert.equal(sha, (await inspectIrx(f.irx)).sha256); assert.deepEqual(addresses, ['0x00000040']);
    return { tool: null, locations: [{ address: addresses[0], resolved: true, frames: [{ function: 'worker', file: 'fixture.c', line: 12 }] }] };
  } };
  const result = await inspectRuntimeIrx(client, { irx: f.irx, module_record: f.module.record_address }, true, undefined, resolver);
  assert.equal(images, 2); assert.equal(result.locations[0].runtime_address, f.module.entry); assert.equal(result.locations[0].frames[0].line, 12);
  assert.equal(result.runtime.elf_role, 'ee_boot_affinity_only'); assert.ok(result.artifact.sha256);
  assert.ok(mock.requests.every(r => ['capabilities', 'iop_module_snapshot', 'iop_module_image'].includes(r.cmd)));
});
test('old capability and SHA mismatch refuse before image reads/source work', async t => {
  const f = await local(t); let supported = false;
  const { client, mock } = await workflowFixture(t, r => r.cmd === 'capabilities' ? { ...caps, features: supported ? caps.features : [] } : f.table);
  await assert.rejects(inspectRuntimeIrx(client, { irx: f.irx, module_record: f.module.record_address }), /iop_module_image/);
  assert.equal(mock.requests.length, 1); supported = true;
  await assert.rejects(inspectRuntimeIrx(client, { irx: f.irx, module_record: f.module.record_address, expected_sha256: '0'.repeat(64) }), /SHA256/);
  assert.ok(!mock.requests.some(r => r.cmd === 'iop_module_image'));
});
test('post-lookup native revision/image/module/file changes invalidate the entire source result', async t => {
  const f = await local(t); let changed, calls = 0;
  const { client } = await workflowFixture(t, r => {
    if (r.cmd === 'capabilities') return caps;
    if (r.cmd === 'iop_module_snapshot') return f.table;
    if (r.cmd === 'iop_module_image') { calls++; return calls === 1 ? f.image : changed; }
  });
  for (const mutate of [s => s.revision++, s => s.execution_epoch++, s => s.sample_pc = '0x00002044',
    s => s.module_image.hex = 'ff' + s.module_image.hex.slice(2), s => s.modules[0].gp = '0x0000a004']) {
    calls = 0; changed = structuredClone(f.image); mutate(changed);
    await assert.rejects(inspectRuntimeIrx(client, { irx: f.irx, module_record: f.module.record_address }));
  }
  calls = 0; changed = f.image;
  await assert.rejects(inspectRuntimeIrx(client, { irx: f.irx, module_record: f.module.record_address }, true, undefined,
    { resolveIrx: async () => { await fs.appendFile(f.irx, Buffer.from([0])); return { tool: null, locations: [] }; } }), /changed/);
});
test('imports, data, aliases and unaligned addresses never get source mappings or call the resolver', async t => {
  const f = await local(t); const { client } = await workflowFixture(t, r => r.cmd === 'capabilities' ? caps : r.cmd === 'iop_module_snapshot' ? f.table : f.image);
  const result = await inspectRuntimeIrx(client, { irx: f.irx, module_record: f.module.record_address,
    addresses: ['0x00002014', '0x00002080', '0x80002040', '0x00002041'] }, true, undefined,
    { resolveIrx: async () => { throw new Error('must not call'); } });
  assert.ok(result.locations.every(l => !l.resolved && l.linked_address === null));
});
test('IRX source resolver treats missing DWARF explicitly and detects mutation around bounded worker', async t => {
  const plain = await local(t, false), debug = await local(t);
  const resolver = new SourceResolver({ backend: 'native', command: path.resolve('addr2line.exe'), runner: async () => { throw new Error('must not run'); } });
  const x = await inspectIrx(plain.irx), result = await resolver.resolveIrx(plain.irx, x.sha256, ['0x00000040']);
  assert.equal(result.locations[0].reason, 'no_debug_line_section'); assert.equal(result.tool, null);
  const compressed = await local(t); compressed.bytes.writeUInt32LE(0x800, compressed.headers['.debug_line'] + 8);
  await fs.writeFile(compressed.irx, compressed.bytes);
  const c = await inspectIrx(compressed.irx);
  assert.equal((await resolver.resolveIrx(c.irx, c.sha256, ['0x00000040'])).locations[0].reason, 'compressed_debug_lines_unsupported');
  await assert.rejects(resolver.resolveIrx(plain.irx, '0'.repeat(64), ['0x00000040']), /changed/);
  const changing = new SourceResolver({ backend: 'native', command: path.resolve('addr2line.exe'), runner: async () => {
    await fs.appendFile(debug.irx, Buffer.from([0])); return '0x00000040\nworker\nfixture.c:12\n';
  } });
  await assert.rejects(changing.resolveIrx(debug.irx, (await inspectIrx(debug.irx)).sha256, ['0x00000040']), /changed/);
});
test('same-byte file replacement/timestamp changes during worker cannot pass solely by restoring its SHA', async t => {
  const f = await local(t), identity = await inspectIrx(f.irx);
  const resolver = new SourceResolver({ backend: 'native', command: path.resolve('addr2line.exe'), runner: async () => {
    await fs.writeFile(f.irx, f.bytes); await fs.utimes(f.irx, new Date(), new Date(Date.now() + 10000));
    return '0x00000040\nworker\nfixture.c:12\n';
  } });
  await assert.rejects(resolver.resolveIrx(f.irx, identity.sha256, ['0x00000040']), /changed/);
});

test('export verification bounds loader links but compares every relocated function pointer and excludes tables from source', () => {
  const f = irxFixture(), at = 36;
  f.bytes.writeUInt32LE(0x41c00000, f.load + at); f.bytes.writeUInt16LE(0x100, f.load + at + 8);
  f.bytes.write('exported', f.load + at + 12); f.bytes.writeUInt32LE(64, f.load + at + 20);
  f.bytes.writeUInt32LE(at + 20, f.load + 160); f.bytes.writeUInt32LE(0x102, f.load + 164);
  const r = runtime(f.bytes); r.actual.writeUInt32LE(0x3000, at); r.actual.writeUInt32LE(0x4000, at + 4); r.actual.writeUInt16LE(1, at + 10);
  const proof = verifyIrxImage(r.irx, r.module, r.actual);
  assert.equal(proof.exports[0].functions, 1); assert.equal(proof.exports[0].library, 'exported');
  assert.equal(proof.eligible(at + 20), false); assert.equal(proof.eligible(64), true);
  assert.equal(proof.compared_executable_bytes_excluding_imports, 64);
  for (const mutate of [b => b.writeUInt32LE(0x41c00000, at + 4), b => b.writeUInt16LE(2, at + 10),
    b => b.writeUInt32LE(0x00200000, at), b => b.writeUInt32LE(0, at + 20), b => b[at + 12] ^= 1]) {
    const value = Buffer.from(r.actual); mutate(value); assert.throws(() => verifyIrxImage(r.irx, r.module, value));
  }
  const unsupported = Buffer.from(f.bytes); unsupported.writeUInt32LE(at, f.load + 160); unsupported.writeUInt32LE(0x100, f.load + 164);
  unsupported.writeUInt32LE(0x2040, f.load + at + 20);
  const changed = runtime(unsupported); assert.throws(() => verifyIrxImage(changed.irx, changed.module, changed.actual), /export relocations/);
});
