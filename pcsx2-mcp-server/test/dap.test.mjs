import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DapFramer, encodeDap } from '../dist/dap-wire.js';
import { Pcsx2DapSession } from '../dist/dap-session.js';
import { SourceResolver, inspectSourceElf } from '../dist/source-debug.js';
import { SourceLineResolver } from '../dist/source-lines.js';
import { debugServer } from './fixtures.mjs';

test('DAP framing uses UTF-8 byte lengths across fragmented/coalesced messages', () => {
  const messages = [], framer = new DapFramer(value => messages.push(value));
  const request = { seq: 1, type: 'request', command: 'initialize', arguments: { text: 'á日本語' } };
  const bytes = Buffer.concat([encodeDap(request), encodeDap({ ...request, seq: 2 })]);
  for (const byte of bytes) framer.feed(Buffer.from([byte]));
  framer.end(); assert.deepEqual(messages, [request, { ...request, seq: 2 }]);
});

test('DAP rejects malformed, oversized, invalid UTF-8 and truncated input', () => {
  for (const header of ['Content-Length: -1\r\n\r\n', 'Content-Length: 0\r\n\r\n', 'Content-Length: 1048577\r\n\r\n', 'Content-Length: 1\r\nContent-Length: 1\r\n\r\n', 'x'.repeat(1025)])
    assert.throws(() => new DapFramer(() => {}).feed(Buffer.from(header)));
  assert.throws(() => new DapFramer(() => {}).feed(Buffer.concat([Buffer.from('Content-Length: 1\r\n\r\n'), Buffer.from([0xff])])));
  const incomplete = new DapFramer(() => {}); incomplete.feed(Buffer.from('Content-Length: 3\r\n\r\n{}')); assert.throws(() => incomplete.end(), /Truncated/);
  assert.throws(() => new DapFramer(() => {}).feed(encodeDap({ seq: -1, type: 'request', command: 'initialize' })));
});

async function fixture(t) {
  let session; t.after(() => session?.dispose());
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dap-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  // Structural ELF; source backend is controlled here. Compiler-generated DWARF
  // and source ownership are separately exercised against actual PCSX2.
  const bytes = Buffer.alloc(512); bytes.set(Buffer.from('7f454c4601010100', 'hex'));
  bytes.writeUInt16LE(2,16); bytes.writeUInt16LE(8,18); bytes.writeUInt32LE(1,20);
  bytes.writeUInt32LE(0x100000,24); bytes.writeUInt32LE(52,28); bytes.writeUInt32LE(128,32);
  bytes.writeUInt16LE(52,40); bytes.writeUInt16LE(32,42); bytes.writeUInt16LE(1,44);
  bytes.writeUInt16LE(40,46); bytes.writeUInt16LE(3,48); bytes.writeUInt16LE(1,50);
  bytes.writeUInt32LE(1,52); bytes.writeUInt32LE(0x100000,60); bytes.writeUInt32LE(32,68); bytes.writeUInt32LE(32,72); bytes.writeUInt32LE(5,76);
  bytes.writeUInt32LE(1,168); bytes.writeUInt32LE(3,172); bytes.writeUInt32LE(300,184); bytes.writeUInt32LE(40,188);
  bytes.writeUInt32LE(11,208); bytes.writeUInt32LE(1,212); bytes.writeUInt32LE(350,224); bytes.writeUInt32LE(16,228);
  Buffer.from('\0.shstrtab\0.debug_line\0').copy(bytes,300);
  const filename = path.join(directory, 'test.elf'); await fs.writeFile(filename, bytes); const elf = await inspectSourceElf(filename);
  const state = { paused: true, revision: 1, epoch: 2, pc: '0x00100000', register: '0'.repeat(32), foreign: false, removals: 0 };
  const caps = { ok: true, protocol_version: 2, process_id: 42, session: 1, execution_epoch: state.epoch,
    elf: 'host:' + filename, elf_crc: elf.elf_crc, features: ['source_breakpoints','variable_inspection','guarded_step'] };
  const native = await debugServer(t, q => {
    switch (q.cmd) {
      case 'capabilities': return { ...caps, execution_epoch: state.epoch };
      case 'status': return { ok: true, data: { alive: true, paused: state.paused, pc: state.pc, cycles: 10 } };
      case 'pause': state.paused = true; return { ok: true };
      case 'resume': state.paused = false; state.revision++; return { ok: true };
      case 'inspect_ee':
        if (!state.paused || q.expected_execution_epoch !== state.epoch || q.expected_revision !== undefined && q.expected_revision !== state.revision)
          return { ok: false, error: 'Stopped state changed' };
        return { ok: true, revision: state.revision, execution_epoch: state.epoch, pc: state.pc,
          gpr: Array(32).fill(state.register), ...(q.address ? { memory: { address: q.address, length: q.length, valid: true, hex: 'ab'.repeat(q.length) } } : {}) };
      case 'get_backtrace': return { ok: true, frames: [{ pc: state.pc, entry: state.pc, sp: '0x00101000', stack_size: 16, disasm: '' }] };
      case 'read_events': return { ok: true, session: 1, oldest_sequence: 1, next_cursor: 0, dropped: false, events: [] };
      case 'install_source_breakpoints': return { ok: true, group_id: q.group_id, session: caps.session,
        elf: caps.elf, elf_crc: caps.elf_crc, addresses: q.addresses.split(',') };
      case 'remove_source_breakpoints': state.removals++; return { ok: true, group_id: q.group_id, complete: !state.foreign,
        removed_addresses: state.foreign ? [] : ['0x00100000'], preserved_addresses: state.foreign ? ['0x00100000'] : [] };
      default: throw new Error('Unexpected native command: ' + q.cmd);
    }
  });
  const messages = [];
  const source = new SourceResolver({ backend: 'native', runner: async () => '0x00100000\nf\n/build/test.c:7\n' });
  const lines = new SourceLineResolver({ runner: async () => JSON.stringify({ format_version: 1, sha256: elf.sha256, dwarf_versions: [2],
    files: ['/build/test.c'], locations: [{ file: '/build/test.c', address: state.pc, line: 7, column: 0, discriminator: 0 }] }) });
  session = new Pcsx2DapSession(m => messages.push(m), { source, lines });
  let seq = 0;
  async function request(command, args = {}) {
    const id = ++seq; await session.request({ seq: id, type: 'request', command, arguments: args });
    return messages.find(m => m.type === 'response' && m.request_seq === id);
  }
  await request('initialize');
  const attached = await request('attach', { port: native.port, elf: filename, pathMappings: [{ from: '/build', to: directory }] });
  assert.equal(attached.success, true, attached.message); await request('configurationDone');
  return { session, request, state, messages, native, elf, filename, directory };
}

test('DAP maps real socket snapshots to frames/registers/memory and expires references after resume', async t => {
  const f = await fixture(t), stack = await f.request('stackTrace', { threadId: 1 }); assert.equal(stack.success, true, stack.message);
  const frame = stack.body.stackFrames[0]; assert.equal(frame.line, 7); assert.equal(frame.source.path.replaceAll('\\','/'), (f.directory + '/test.c').replaceAll('\\','/'));
  const scopes = await f.request('scopes', { frameId: frame.id });
  const ref = scopes.body.scopes[0].variablesReference, registers = await f.request('variables', { variablesReference: ref });
  assert.equal(registers.body.variables.length, 33); assert.equal(registers.body.variables[0].value, '0x' + '0'.repeat(32));
  const memory = await f.request('readMemory', { memoryReference: '0x00100000', count: 4 });
  assert.equal(Buffer.from(memory.body.data, 'base64').toString('hex'), 'abababab');
  assert.equal((await f.request('readMemory', { memoryReference: '0x10000000', count: 4 })).success, false);
  await f.request('continue', { threadId: 1 }); assert.equal(f.state.paused, false);
  await f.request('pause', { threadId: 1 });
  assert.equal((await f.request('variables', { variablesReference: ref })).success, false);
  assert.equal((await f.request('scopes', { frameId: frame.id })).success, false);
});

test('DAP guards references against same-revision register edits and VM resets', async t => {
  const f = await fixture(t); const frame = (await f.request('stackTrace', { threadId: 1 })).body.stackFrames[0];
  f.state.register = '1'.repeat(32);
  const edited = await f.request('scopes', { frameId: frame.id }); assert.equal(edited.success, false); assert.match(edited.message, /registers changed/);
  f.state.register = '0'.repeat(32); f.state.epoch++;
  assert.equal((await f.request('scopes', { frameId: frame.id })).success, false);
});

test('DAP source replacement and detach preserve changed ownership and unsupported line options', async t => {
  const f = await fixture(t), source = { path: path.join(f.directory, 'test.c') };
  const installed = await f.request('setBreakpoints', { source, breakpoints: [{ line: 7 }] });
  assert.equal(installed.success, true, installed.message); assert.equal(installed.body.breakpoints[0].verified, true, JSON.stringify(installed.body));
  f.state.foreign = true;
  const refused = await f.request('setBreakpoints', { source, breakpoints: [] }); assert.equal(refused.success, false); assert.match(refused.message, /ownership/);
  assert.equal(f.state.paused, true);
  const detached = await f.request('disconnect'); assert.equal(detached.success, true); assert.ok(f.messages.some(m => m.event === 'output' && /preserved changed group/.test(m.body.output)));
  assert.equal(f.state.paused, true); assert.ok(f.state.removals >= 2);
});

test('DAP unsupported breakpoint options remain unverified without native installation', async t => {
  const f = await fixture(t), source = { path: path.join(f.directory, 'test.c') };
  const result = await f.request('setBreakpoints', { source, breakpoints: [
    { line: 7, condition: 'a0 == 1' }, { line: 7, hitCondition: '3' }, { line: 7, logMessage: 'hello' }, { line: 7, column: 1 },
  ] });
  assert.equal(result.success, true); assert.ok(result.body.breakpoints.every(bp => !bp.verified));
  assert.equal(f.native.requests.filter(q => q.cmd === 'install_source_breakpoints').length, 0);
});

test('DAP attach rejects wrong artifact hash and remote host before native connection', async t => {
  const f = await fixture(t), messages = [], session = new Pcsx2DapSession(m => messages.push(m));
  t.after(() => session.dispose());
  const count = f.native.requests.length;
  await session.request({ seq: 1, type: 'request', command: 'initialize' });
  for (const [index, extra] of [{ expectedSha256: '0'.repeat(64) }, { host: '192.0.2.1' }].entries()) {
    await session.request({ seq: index + 2, type: 'request', command: 'attach', arguments: { port: f.native.port, elf: f.filename, ...extra } });
    assert.equal(messages.at(-1).success, false);
  }
  assert.equal(f.native.requests.length, count);
});

test('DAP reports incomplete source stepping as failure with the stopped state observable', async t => {
  const f = await fixture(t);
  // Explicit backend failure injection; actual three-mode source execution is
  // covered by dap-live.mjs, not simulated here.
  f.session.stepper = { run: async () => ({ completed: false, reason: 'instruction_limit', cleanup_complete: true }) };
  const reply = await f.request('next', { threadId: 1, granularity: 'line' });
  assert.equal(reply.success, false); assert.match(reply.message, /instruction_limit/);
  assert.ok(f.messages.some(m => m.event === 'stopped' && m.body.reason === 'step'));
  assert.equal(f.state.paused, true);
});

test('DAP stdio implements initialize and rejects unsupported launch without spawning an emulator', async t => {
  const child = spawn(process.execPath, ['dist/dap.js'], { cwd: path.resolve(import.meta.dirname, '..'), stdio: ['pipe','pipe','pipe'] });
  t.after(() => child.kill()); const output = []; child.stdout.on('data', b => output.push(b));
  child.stdin.end(Buffer.concat([encodeDap({ seq: 1, type: 'request', command: 'initialize' }), encodeDap({ seq: 2, type: 'request', command: 'launch' })]));
  const [code] = await once(child, 'exit'); assert.equal(code, 0);
  const bytes = Buffer.concat(output).toString('utf8'); assert.match(bytes, /"supportsReadMemoryRequest":true/); assert.match(bytes, /"request_seq":2.*"success":false/);
});

test('DAP stdio malformed header exits with failure instead of waiting indefinitely', async t => {
  const child = spawn(process.execPath, ['dist/dap.js'], { cwd: path.resolve(import.meta.dirname, '..'), stdio: ['pipe','pipe','pipe'] });
  t.after(() => child.kill()); child.stdout.resume(); child.stderr.resume();
  child.stdin.write('Content-Length: 1048577\r\n\r\n');
  const outcome = await Promise.race([once(child, 'exit'), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('DAP malformed-input shutdown hung')), 5000); timer.unref(); })]);
  assert.equal(outcome[0], 1);
});
