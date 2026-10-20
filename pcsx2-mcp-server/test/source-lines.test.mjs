import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SourceLineResolver, selectSourceFile } from '../dist/source-lines.js';
import { inspectSourceElf } from '../dist/source-debug.js';
import { workflowFixture, capabilities } from './workflow-fixtures.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcsx2-line á-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const elf = path.join(directory, 'debug.elf');
  const data = Buffer.alloc(512); data.set(Buffer.from('7f454c4601010100', 'hex'));
  data.writeUInt16LE(2, 16); data.writeUInt16LE(8, 18); data.writeUInt32LE(1, 20);
  data.writeUInt32LE(0x100000, 24); data.writeUInt32LE(52, 28); data.writeUInt32LE(128, 32);
  data.writeUInt16LE(52, 40); data.writeUInt16LE(32, 42); data.writeUInt16LE(1, 44);
  data.writeUInt16LE(40, 46); data.writeUInt16LE(3, 48); data.writeUInt16LE(1, 50);
  data.writeUInt32LE(1, 52); data.writeUInt32LE(0x100000, 60); data.writeUInt32LE(32, 68); data.writeUInt32LE(32, 72); data.writeUInt32LE(5, 76);
  data.writeUInt32LE(1, 168); data.writeUInt32LE(3, 172); data.writeUInt32LE(300, 184); data.writeUInt32LE(40, 188);
  data.writeUInt32LE(11, 208); data.writeUInt32LE(1, 212); data.writeUInt32LE(350, 224); data.writeUInt32LE(16, 228);
  Buffer.from('\0.shstrtab\0.debug_line\0').copy(data, 300); await fs.writeFile(elf, data);
  const identity = await inspectSourceElf(elf);
  const decoded = { format_version: 1, sha256: identity.sha256, dwarf_versions: [2], files: ['/build/src/main.c'],
    locations: [0x100000, 0x100004, 0x100004, 0x100001, 0x40000000].map(value => ({ file: '/build/src/main.c', address: '0x' + value.toString(16).padStart(8, '0'), line: 7, column: 0, discriminator: 0 })) };
  const resolver = new SourceLineResolver({ runner: async (_command, args) => {
    assert.ok(args.includes('-I')); return JSON.stringify(decoded);
  } });
  return { elf, identity, decoded, resolver, input: { elf, file: 'src/main.c', line: 7 } };
}

test('source mapping uses explicit prefixes, exact boundaries and rejects ambiguous filenames', () => {
  const files = ['/src/client/main.c', '/src/library/main.c'];
  assert.throws(() => selectSourceFile(files, 'main.c', []), /ambiguous/);
  assert.equal(selectSourceFile(files, 'D:\\snap á\\client\\main.c', [{ from: '/src', to: 'D:/snap á' }]).original, files[0]);
  assert.throws(() => selectSourceFile(files, '/wrong/main.c', []), /not found/);
  assert.throws(() => selectSourceFile(files, '../main.c', []), /parent traversal/);
  assert.throws(() => selectSourceFile(files, 'main.c', [{ from: '/src', to: '/a' }, { from: '/src', to: '/b' }]), /Duplicate/);
  assert.equal(selectSourceFile(['/src2/main.c'], '/src2/main.c', [{ from: '/src', to: '/wrong' }]).mapped, '/src2/main.c');
});

test('exact line lookup deduplicates aligned executable statements and never shifts an empty line', async t => {
  const f = await fixture(t);
  const result = await f.resolver.resolve(f.input);
  assert.deepEqual(result.addresses, ['0x00100000', '0x00100004']);
  f.decoded.locations = [];
  const empty = await f.resolver.resolve({ ...f.input, line: 8 });
  assert.equal(empty.resolved, false); assert.equal(empty.resolved_line, null);
  assert.equal(empty.reason, 'no_executable_statement_on_exact_line');
  await assert.rejects(f.resolver.resolve({ ...f.input, expected_sha256: '0'.repeat(64) }), /SHA256/);
  f.decoded.sha256 = '0'.repeat(64);
  await assert.rejects(f.resolver.resolve(f.input), /changed before/);
});

async function connected(t, f, override = () => undefined) {
  const caps = { ...capabilities, process_id: 22, elf: 'host:' + f.elf, elf_crc: f.identity.elf_crc, features: [...capabilities.features, 'source_breakpoints'] };
  const groups = new Map();
  const result = await workflowFixture(t, request => {
    const custom = override(request, caps, groups);
    if (custom !== undefined) return custom;
    if (request.cmd === 'capabilities') return caps;
    if (request.cmd === 'status') return { ok: true, data: { alive: true, paused: true, pc: '0x00100010', cycles: 1 } };
    if (request.cmd === 'install_source_breakpoints') {
      groups.set(request.group_id, request.addresses.split(','));
      return { ok: true, ...caps, group_id: request.group_id, addresses: groups.get(request.group_id) };
    }
    if (request.cmd === 'remove_source_breakpoints') {
      const addresses = groups.get(request.group_id); groups.delete(request.group_id);
      return { ok: true, group_id: request.group_id, complete: true, removed_addresses: addresses ?? [], preserved_addresses: [] };
    }
  });
  return { ...result, caps, groups };
}

test('source installation passes identity guard and returns an owned group without resuming', async t => {
  const f = await fixture(t); const { client, mock, groups, caps } = await connected(t, f);
  const result = await f.resolver.install(client, f.input);
  assert.match(result.group_id, /^[\da-f]{32}$/); assert.equal(groups.size, 1);
  const request = mock.requests.find(item => item.cmd === 'install_source_breakpoints');
  assert.equal(request.expected_session, caps.session); assert.equal(request.expected_elf, caps.elf);
  assert.equal(request.expected_process_id, 22); assert.equal(request.addresses, '0x00100000,0x00100004');
  assert.ok(!mock.requests.some(item => ['pause', 'resume', 'set_pc', 'set_breakpoint'].includes(item.cmd)));
  assert.equal((await client.removeSourceBreakpoints(result.group_id)).complete, true);
  assert.equal(groups.size, 0);
});

test('wrong ELF, running VM and native identity/conflict rejection do not install or clear breakpoints', async t => {
  const f = await fixture(t); let mode = 'wrong';
  const { client, mock } = await connected(t, f, (request, caps) => {
    if (request.cmd === 'capabilities' && mode === 'wrong') return { ...caps, elf_crc: '0x00000000' };
    if (request.cmd === 'status' && mode === 'running') return { ok: true, data: { paused: false, pc: '0x00100010', alive: true, cycles: 1 } };
    if (request.cmd === 'install_source_breakpoints' && mode === 'conflict') return { ok: false, error: 'Existing breakpoint; no changes' };
  });
  await assert.rejects(f.resolver.install(client, f.input), /path\/CRC/);
  mode = 'running'; await assert.rejects(f.resolver.install(client, f.input), /Pause/);
  assert.ok(!mock.requests.some(item => item.cmd === 'install_source_breakpoints'));
  mode = 'conflict'; await assert.rejects(f.resolver.install(client, f.input), /Existing breakpoint/);
  assert.ok(!mock.requests.some(item => item.cmd === 'remove_source_breakpoints' || item.cmd === 'clear_breakpoints'));
});

test('cancellation after native installation removes only its group', async t => {
  const f = await fixture(t), abort = new AbortController();
  const { client, groups, mock } = await connected(t, f, request => {
    if (request.cmd === 'install_source_breakpoints') abort.abort();
  });
  await assert.rejects(f.resolver.install(client, f.input, abort.signal), /installation failed/);
  assert.equal(groups.size, 0);
  assert.equal(mock.requests.filter(item => item.cmd === 'remove_source_breakpoints').length, 1);
  assert.ok(!mock.requests.some(item => item.cmd === 'clear_breakpoints'));
});

test('identity change after install reports unconfirmed group cleanup without touching the changed VM', async t => {
  const f = await fixture(t); let installed = false;
  const { client, mock } = await connected(t, f, (request, caps) => {
    if (request.cmd === 'install_source_breakpoints') installed = true;
    if (request.cmd === 'capabilities' && installed) return { ...caps, session: caps.session + 1 };
    if (request.cmd === 'remove_source_breakpoints') return { ok: false, error: 'VM/ELF identity changed; not removed' };
  });
  await assert.rejects(f.resolver.install(client, f.input), error => {
    assert.match(error.message, /identity changed/); assert.match(error.cleanup.pending_group_id, /^[\da-f]{32}$/); return true;
  });
  assert.ok(!mock.requests.some(item => item.cmd === 'remove_breakpoint' || item.cmd === 'clear_breakpoints'));
});

test('unexpected native group response triggers cleanup of the requested group only', async t => {
  const f = await fixture(t);
  const { client, groups } = await connected(t, f, (request, caps, groups) => {
    if (request.cmd === 'install_source_breakpoints') {
      groups.set(request.group_id, request.addresses.split(','));
      return { ...caps, group_id: 'f'.repeat(32), addresses: request.addresses.split(',') };
    }
  });
  await assert.rejects(f.resolver.install(client, f.input), /Unexpected native/);
  assert.equal(groups.size, 0);
});
