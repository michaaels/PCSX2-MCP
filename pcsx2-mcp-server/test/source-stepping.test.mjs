import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SourceStepper } from '../dist/source-stepping.js';
import { inspectSourceElf } from '../dist/source-debug.js';
import { workflowFixture, capabilities } from './workflow-fixtures.mjs';

const hex = value => '0x' + value.toString(16).padStart(8, '0');
async function setup(t, sequence, override = () => undefined, inline = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcsx2-step-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const elf = path.join(directory, 'step.elf'), data = Buffer.alloc(512);
  data.set(Buffer.from('7f454c4601010100', 'hex'));
  data.writeUInt16LE(2, 16); data.writeUInt16LE(8, 18); data.writeUInt32LE(1, 20);
  data.writeUInt32LE(0x100000, 24); data.writeUInt32LE(52, 28); data.writeUInt32LE(128, 32);
  data.writeUInt16LE(52, 40); data.writeUInt16LE(32, 42); data.writeUInt16LE(1, 44);
  data.writeUInt16LE(40, 46); data.writeUInt16LE(3, 48); data.writeUInt16LE(1, 50);
  data.writeUInt32LE(1, 52); data.writeUInt32LE(0x100000, 60);
  data.writeUInt32LE(128, 68); data.writeUInt32LE(128, 72); data.writeUInt32LE(5, 76);
  data.writeUInt32LE(1, 168); data.writeUInt32LE(3, 172); data.writeUInt32LE(300, 184); data.writeUInt32LE(40, 188);
  data.writeUInt32LE(11, 208); data.writeUInt32LE(1, 212); data.writeUInt32LE(350, 224); data.writeUInt32LE(16, 228);
  Buffer.from('\0.shstrtab\0.debug_line\0').copy(data, 300); await fs.writeFile(elf, data);
  const identity = await inspectSourceElf(elf);
  const caps = { ...capabilities, execution_epoch: 7, elf: 'host:' + elf, elf_crc: identity.elf_crc, features: ['guarded_step'] };
  let pc = '0x00100000', operationId = 0, current;
  const { client, mock } = await workflowFixture(t, async request => {
    const supplied = await override(request, caps, current);
    if (supplied !== undefined) return supplied;
    if (request.cmd === 'capabilities') return caps;
    if (request.cmd === 'status') return { ok: true, data: { alive: true, paused: true, pc, cycles: 1 } };
    if (request.cmd === 'guarded_step') {
      assert.equal(request.expected_pc, pc); assert.equal(request.expected_execution_epoch, 7);
      const next = sequence.shift(); assert.ok(next, 'No further instruction should execute');
      current = { ok: true, operation_id: ++operationId, execution_epoch: 7, active: false, paused: true,
        old_pc: pc, pc: hex(next.target), target: hex(next.target), opcode: '0x00000000',
        instruction_units: 1, is_call: false, is_return: false, cause: '0x00000000', epc: '0x00000000',
        cleanup_complete: true, reason: 'completed', ...next };
      current.target = hex(next.target); pc = current.pc;
      return current;
    }
    if (request.cmd === 'guarded_step_cancel') return { ...current, active: false, paused: true, reason: 'cancelled' };
    if (request.cmd === 'guarded_step_status') return { ...current, active: false, paused: true };
  });
  const resolver = { resolve: async ({ addresses }) => ({ locations: addresses.map(address => ({ address, resolved: true,
    frames: [{ file: '/build/main.c', line: Number(address) < 0x10000c ? 4 : 5, function: 'main' }, ...(inline ? [{ file: '/build/main.c', line: 8, function: '_start' }] : [])] })) }) };
  const stepper = new SourceStepper({ resolver, runner: async (_exe, args) => {
    assert.deepEqual(args.slice(-2), ['--pc', '0x00100000']);
    return JSON.stringify({ sha256: identity.sha256, current: { file: '/build/main.c', line: 4 },
      locations: [{ file: '/build/main.c', line: 4, address: '0x00100000', end: 0x10000c }] });
  } });
  return { client, mock, stepper, identity, caps };
}

test('into stops on a line change, while over executes nested calls inside the instruction budget', async t => {
  const call = { target: 0x100020, is_call: true, instruction_units: 2 };
  const into = await setup(t, [call]);
  const result = await into.stepper.run(into.client, { mode: 'into' });
  assert.equal(result.reason, 'source_changed'); assert.equal(result.steps, 1); assert.equal(result.instruction_units, 2);
  const over = await setup(t, [call, { target: 0x100024 }, { target: 0x100008, is_return: true, instruction_units: 2 }, { target: 0x10000c }]);
  const next = await over.stepper.run(over.client, { mode: 'over' });
  assert.equal(next.completed, true); assert.equal(next.pc, '0x0010000c'); assert.equal(next.steps, 4); assert.equal(next.instruction_units, 6);
  assert.ok(!over.mock.requests.some(item => ['step', 'step_over', 'set_pc', 'resume', 'clear_breakpoints'].includes(item.cmd)));
});

test('out tracks nested physical calls and rejects a mismatched return', async t => {
  const f = await setup(t, [{ target: 0x100020, is_call: true }, { target: 0x100008, is_return: true }, { target: 0x100040, is_return: true }]);
  assert.equal((await f.stepper.run(f.client, { mode: 'out' })).reason, 'returned');
  const bad = await setup(t, [{ target: 0x100020, is_call: true }, { target: 0x10000c, is_return: true }]);
  assert.equal((await bad.stepper.run(bad.client, { mode: 'out' })).reason, 'return_mismatch');
  const inline = await setup(t, [], () => undefined, true);
  await assert.rejects(inline.stepper.run(inline.client, { mode: 'out' }), /inline frame/);
});

test('instruction limit and native refusal stop without another instruction or broad cleanup', async t => {
  const f = await setup(t, [{ target: 0x100004 }, { target: 0x100008 }]);
  const limited = await f.stepper.run(f.client, { max_instruction_units: 2 });
  assert.equal(limited.reason, 'instruction_limit'); assert.equal(limited.completed, false); assert.equal(limited.steps, 2);
  const conflict = await setup(t, [], request => request.cmd === 'guarded_step' ? { ok: false, error: 'Existing breakpoint' } : undefined);
  const refused = await conflict.stepper.run(conflict.client, {});
  assert.equal(refused.reason, 'native_refused'); assert.equal(refused.steps, 0); assert.equal(refused.cleanup_complete, true);
  assert.ok(!conflict.mock.requests.some(item => item.cmd.includes('cancel') || item.cmd.includes('remove')));
});

test('watchpoint, exception and changed VM stop source stepping immediately', async t => {
  for (const reason of ['watchpoint', 'exception', 'breakpoint']) {
    const f = await setup(t, [{ target: 0x100004, reason }]);
    const result = await f.stepper.run(f.client, { mode: 'out' });
    assert.equal(result.reason, reason); assert.equal(result.completed, false); assert.equal(result.steps, 1);
  }
  const changed = await setup(t, [{ target: 0x100004, execution_epoch: 8 }]);
  assert.equal((await changed.stepper.run(changed.client, {})).reason, 'vm_changed');
});

test('cancellation cancels only the pending native operation, and preparation refusal never resumes', async t => {
  const controller = new AbortController();
  const f = await setup(t, [{ target: 0x100004, active: true, paused: false }], request => {
    if (request.cmd === 'guarded_step_status') controller.abort();
  });
  // Abort as soon as the initial active result arrives, before polling can finish.
  const start = f.client.startGuardedStep.bind(f.client);
  f.client.startGuardedStep = async (...args) => { const result = await start(...args); controller.abort(); return result; };
  const result = await f.stepper.run(f.client, {}, controller.signal);
  assert.equal(result.reason, 'cancelled'); assert.equal(result.cleanup_complete, true);
  assert.deepEqual(f.mock.requests.filter(item => item.cmd.endsWith('_cancel')).map(item => item.operation_id), [1]);
  const wrong = await setup(t, []);
  await assert.rejects(wrong.stepper.run(wrong.client, { expected_sha256: '0'.repeat(64) }), /SHA256/);
  wrong.caps.features = [];
  await assert.rejects(wrong.stepper.run(wrong.client, {}), /Rebuild/);
  assert.ok(!wrong.mock.requests.some(item => item.cmd === 'guarded_step'));
});

test('execution deadline cancels a still-active step; a lost start reply reports unconfirmed cleanup', async t => {
  const f = await setup(t, [{ target: 0x100004, active: true, paused: false }], (request, _caps, current) =>
    request.cmd === 'guarded_step_status' ? { ...current, active: true, paused: false } : undefined);
  const limited = await f.stepper.run(f.client, { timeout_ms: 100 });
  assert.equal(limited.reason, 'timeout'); assert.equal(limited.completed, false); assert.equal(limited.cleanup_complete, true);
  assert.equal(f.mock.requests.filter(request => request.cmd === 'guarded_step_cancel').length, 1);
  const lost = await setup(t, []);
  lost.client.startGuardedStep = async () => { throw new Error('Connection lost before operation ID'); };
  const uncertain = await lost.stepper.run(lost.client, {});
  assert.equal(uncertain.completed, false); assert.equal(uncertain.cleanup_complete, false);
  assert.equal(uncertain.pending_operation_id, null);
});
