import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { exceptionOptions, parseExceptionReport } from '../dist/exceptions.js';
import { startExceptionWatch, readExceptionReport, saveExceptionReport } from '../dist/exception-tools.js';
import { workflowFixture, capabilities } from './workflow-fixtures.mjs';
import { contextResponse, history } from './fixtures.mjs';

const id = 'a'.repeat(32), other = 'b'.repeat(32);
const caps = { ...capabilities, execution_epoch: 7, features: ['ee_exception_watch'] };
function state(state = 'armed', report = null, watch_id = id) {
  return { ok: true, watch_id, state, active: ['armed', 'capturing'].includes(state), session: 1,
    execution_epoch: 7, elf: caps.elf, elf_crc: caps.elf_crc, report };
}
function report() {
  const context = { ...contextResponse(), elf: caps.elf };
  const cp0 = Array(32).fill('0x00000000'); cp0[13] = '0x00000024'; cp0[14] = '0x00100000';
  return { watch_id: id, cpu: 'ee', timestamp_ms: 1, session: 1, execution_epoch: 7, elf: caps.elf, elf_crc: caps.elf_crc,
    context_matches_stop: true, screenshot_requested: true,
    core: { exception_pc: '0x00100000', post_exception_pc: '0x00100000', raw_code: '0x00000024', exception_code: 9,
      requested_branch_delay: false, previous_exl: false, cause: cp0[13], epc: cp0[14], bad_vaddr: cp0[8], status: cp0[12],
      bad_vaddr_relevant: false, gpr: Array(32).fill('0'.repeat(32)), cp0 },
    memory: { code: { address: '0x00100000', length: 64, valid: true, hex: '0d000000'.repeat(16) },
      stack: { address: '0x00101000', length: 256, valid: true, hex: 'ab'.repeat(256) } },
    events: history('events', [{ sequence: 1, timestamp_ms: 1, type: 'ee_exception', cpu: 'ee', pc: '0x00100000', detail: id }]), context };
}
function iopReport() {
  const r = report(); r.cpu = 'iop'; r.context.cpu = 'iop';
  r.iop_reset_epoch = 3; r.iop_reset_scope = 'cpu_reset_only'; r.elf_role = 'ee_boot_affinity_only'; r.module_identity = null;
  r.core.previous_exl = null; r.core.previous_status = '0x00400401';
  r.core.status = '0x00400404'; r.core.cp0[12] = r.core.status; r.core.hi = '0x00000001'; r.core.lo = '0x00000002';
  r.events.events[0].cpu = 'iop'; r.events.events[0].type = 'iop_exception';
  return r;
}
const iopCaps = { ...caps, features: ['iop_exception_watch'], iop_reset_epoch: 3, iop_reset_scope: 'cpu_reset_only' };
const iopState = (phase = 'armed', value = null, watch_id = id) => ({ ...state(phase, value, watch_id), cpu: 'iop', iop_reset_epoch: 3, iop_reset_scope: 'cpu_reset_only' });

test('IOP watcher passes its own CPU/reset identity and retains captured evidence independently of current capabilities', async t => {
  let chosen;
  const { client, mock } = await workflowFixture(t, request => {
    if (request.cmd === 'capabilities') return iopCaps;
    if (request.cmd === 'exception_watch_start') { chosen = request.watch_id; return iopState('armed', null, chosen); }
    if (request.cmd === 'exception_watch_status') { const r = iopReport(); r.watch_id = chosen; return iopState('captured', r, chosen); }
  });
  const started = await startExceptionWatch(client, { cpu: 'iop', exception_codes: [9] });
  const sent = mock.requests.find(r => r.cmd === 'exception_watch_start');
  assert.equal(sent.cpu, 'iop'); assert.equal(sent.expected_iop_reset_epoch, 3); assert.equal(started.cpu, 'iop');
  const result = await readExceptionReport(client, chosen);
  assert.equal(result.report.observation, 'configured_iop_exception'); assert.equal(result.report.core.previous_exl, null);
  assert.equal(result.report.elf_role, 'ee_boot_affinity_only');
  assert.ok(result.report.partial_reasons.includes('iop_module_identity_unavailable'));
});
test('IOP report requires CPU-specific mode stack, 32-bit GPRs and explicit unknown module identity', () => {
  const parsed = parseExceptionReport(iopReport()); assert.equal(parsed.cpu, 'iop');
  for (const mutate of [r => delete r.iop_reset_epoch, r => delete r.iop_reset_scope, r => r.elf_role = 'ee_executable',
    r => delete r.module_identity, r => r.core.previous_exl = false, r => delete r.core.previous_status,
    r => delete r.core.hi, r => r.core.gpr[8] = '00000000000000000000000100000000',
    r => r.core.previous_status = '0x00400400', r => r.context.cpu = 'ee',
    r => r.memory.code.address = '0x00200000']) {
    const value = iopReport(); mutate(value); assert.throws(() => parseExceptionReport(value));
  }
});
test('old native builds refuse IOP before mutation; IOP CPU reset/cancel states and report epoch mismatches stay explicit', async t => {
  let value = iopState('cpu_reset');
  const { client, mock } = await workflowFixture(t, request => {
    if (request.cmd === 'capabilities') return caps;
    if (request.cmd === 'exception_watch_status') return value;
  });
  await assert.rejects(startExceptionWatch(client, { cpu: 'iop' }), /iop_exception_watch/);
  assert.ok(mock.requests.every(r => r.cmd === 'capabilities'));
  const reset = await readExceptionReport(client, id); assert.equal(reset.state, 'cpu_reset'); assert.equal(reset.timed_out, false);
  const stale = iopReport(); stale.iop_reset_epoch++; value = iopState('captured', stale);
  await assert.rejects(readExceptionReport(client, id), /identity/);
  value = { ...iopState('captured', iopReport()), cpu: 'ee' };
  await assert.rejects(readExceptionReport(client, id), /identity/);
});

test('exception defaults exclude normal interrupts, syscalls and TLB refills; filter is bounded', () => {
  const options = exceptionOptions.parse({});
  for (const code of [0, 1, 2, 3, 8]) assert.ok(!options.exception_codes.includes(code));
  for (const invalid of [[], [32], [-1], [1.5], Array(33).fill(9)]) assert.throws(() => exceptionOptions.parse({ exception_codes: invalid }));
  assert.throws(() => exceptionOptions.parse({ timeout_ms: 99 }));
});
test('native start deduplicates mask, preserves bit31 unsigned and passes VM identity without resuming', async t => {
  let armed;
  const { client, mock } = await workflowFixture(t, request => {
    if (request.cmd === 'capabilities') return caps;
    if (request.cmd === 'exception_watch_start') { armed = request; return state('armed', null, request.watch_id); }
  });
  const result = await startExceptionWatch(client, { exception_codes: [31, 9, 9], screenshot: false });
  assert.equal(armed.exception_mask, 2 ** 31 + 2 ** 9); assert.equal(armed.expected_execution_epoch, 7);
  assert.equal(result.resumes_vm, false); assert.equal(armed.expected_elf, caps.elf);
  assert.ok(!mock.requests.some(r => ['resume', 'pause', 'set_breakpoint', 'remove_breakpoint'].includes(r.cmd)));
});
test('native rejection does not cancel somebody else’s watch; uncertain start cleans its chosen ID only', async t => {
  let reject = true, chosen;
  const { client, mock } = await workflowFixture(t, request => {
    if (request.cmd === 'capabilities') return caps;
    if (request.cmd === 'exception_watch_start') { chosen = request.watch_id; return reject ? { ok: false, error: 'already active' } : state('armed', null, other); }
    if (request.cmd === 'exception_watch_cancel') return state('cancelled', null, request.watch_id);
  });
  await assert.rejects(startExceptionWatch(client, {}), /already active/);
  assert.equal(mock.requests.filter(r => r.cmd === 'exception_watch_cancel').length, 0);
  reject = false; await assert.rejects(startExceptionWatch(client, {}), /identity/);
  assert.equal(mock.requests.at(-1).watch_id, chosen);
});
test('immutable report validates core, bounded memory, CP0 consistency and context identity', () => {
  assert.equal(parseExceptionReport(report()).complete, true);
  for (const mutate of [r => r.core.exception_code++, r => r.core.cp0[14] = '0x00100004',
    r => r.memory.code.hex = '00', r => r.memory.stack.valid = false,
    r => r.context.session++, r => r.context.cpu = 'iop', r => r.events.session++,
    r => r.context.status.data.pc = '0x00100004', r => r.core.gpr.pop()]) {
    const value = report(); mutate(value); assert.throws(() => parseExceptionReport(value));
  }
});
test('lost extended state and missing GS frame remain explicit partial evidence', () => {
  const missingFrame = report(); missingFrame.context.screenshot = { ok: false, error: 'No GS frame' };
  assert.deepEqual(parseExceptionReport(missingFrame).partial_reasons, ['No GS frame']);
  missingFrame.screenshot_requested = false; assert.equal(parseExceptionReport(missingFrame).complete, true);
  const changed = report(); changed.context_matches_stop = false; changed.memory = {}; delete changed.events;
  changed.context = { ok: false, error: 'Paused state changed' };
  const parsed = parseExceptionReport(changed); assert.equal(parsed.complete, false);
  assert.equal(parsed.core.exception_pc, '0x00100000'); assert.equal(parsed.partial_reasons.length, 5);
});
test('BREAK provenance preserves JIT PC/opcode/BD independently from raw hook and CP0 disagreement', () => {
  const value = report();
  value.core.instruction = { source: 'ee_recompiler_break', pc: '0x00100000', opcode: '0x0000000d', branch_delay: false, opcode_matches_memory: true };
  const normal = parseExceptionReport(value);
  assert.equal(normal.instruction_evidence.status, 'verified');
  assert.deepEqual(normal.instruction_evidence.consistency,
    { entry_pc_matches: true, bd_argument_matches: true, epc_matches: true, cause_bd_matches: true });
  value.core.instruction.pc = '0x00100004'; value.core.instruction.branch_delay = true;
  const delayed = parseExceptionReport(value);
  assert.deepEqual(delayed.instruction_evidence.consistency,
    { entry_pc_matches: false, bd_argument_matches: false, epc_matches: true, cause_bd_matches: false });
  assert.equal(delayed.core.epc, value.core.epc); assert.equal(delayed.core.exception_pc, '0x00100000');
  assert.equal(delayed.core.requested_branch_delay, false); // Observed architectural fields are never repaired.
});
test('nested EXL, old servers and unverified instruction bytes do not invent architectural provenance', () => {
  assert.equal(parseExceptionReport(report()).instruction_evidence.status, 'unavailable');
  const value = report(); value.core.previous_exl = true;
  value.core.instruction = { source: 'ee_recompiler_break', pc: '0x00100004', opcode: '0x0000000d', branch_delay: true, opcode_matches_memory: true };
  const nested = parseExceptionReport(value);
  assert.equal(nested.instruction_evidence.consistency.epc_matches, null);
  assert.equal(nested.instruction_evidence.consistency.cause_bd_matches, null);
  value.core.instruction.opcode_matches_memory = false;
  const changed = parseExceptionReport(value);
  assert.equal(changed.instruction_evidence.status, 'unverified'); assert.equal(changed.complete, false);
  assert.ok(changed.partial_reasons.includes('break_instruction_opcode_not_verified'));
});
test('rejects malformed provenance and stale BREAK origin on another exception code', () => {
  for (const mutate of [r => r.core.instruction.pc = '0x00100001', r => r.core.instruction.opcode = '0x0000000c',
    r => { r.core.exception_code = 8; r.core.raw_code = '0x00000020'; }, r => r.core.instruction.source = 'guessed_epc']) {
    const value = report(); value.core.instruction = { source: 'ee_recompiler_break', pc: '0x00100000', opcode: '0x0000000d', branch_delay: false, opcode_matches_memory: true };
    mutate(value); assert.throws(() => parseExceptionReport(value));
  }
});
test('EE/IOP syscall and IOP BREAK origins validate CPU, opcode and exception kind independently', () => {
  for (const cpu of ['ee', 'iop']) for (const code of [8, 9]) {
    const value = cpu === 'ee' ? report() : iopReport();
    const syscall = code === 8;
    value.core.exception_code = code; value.core.raw_code = syscall ? '0x00000020' : '0x00000024';
    value.core.cause = value.core.raw_code; value.core.cp0[13] = value.core.cause;
    value.core.instruction = { source: `${cpu}_recompiler_${syscall ? 'syscall' : 'break'}`, pc: '0x00100004',
      opcode: syscall ? '0x000abc0c' : '0x000abc0d', branch_delay: true, opcode_matches_memory: true };
    const parsed = parseExceptionReport(value);
    assert.equal(parsed.instruction_evidence.status, 'verified');
    assert.equal(parsed.instruction_evidence.consistency.bd_argument_matches, false);
    assert.equal(parsed.instruction_evidence.consistency.epc_matches, true);
    assert.equal(parsed.instruction_evidence.consistency.cause_bd_matches, false);
    assert.equal(parsed.core.requested_branch_delay, false);
    if (cpu === 'iop') assert.ok(parsed.partial_reasons.includes('iop_module_identity_unavailable'));
    for (const mutate of [r => r.core.instruction.source = `${cpu === 'ee' ? 'iop' : 'ee'}_recompiler_${syscall ? 'syscall' : 'break'}`,
      r => r.core.instruction.opcode = syscall ? '0x0000000d' : '0x0000000c',
      r => r.core.instruction.opcode = '0x1000000c', r => r.core.instruction.pc = '0x80010000']) {
      const malformed = structuredClone(value); mutate(malformed); assert.throws(() => parseExceptionReport(malformed));
    }
    value.core.instruction.opcode_matches_memory = false; value.core.instruction.pc = '0x80010000';
    const excluded = parseExceptionReport(value);
    assert.equal(excluded.instruction_evidence.status, 'unverified');
    assert.ok(excluded.partial_reasons.includes(syscall ? 'syscall_instruction_opcode_not_verified' : 'break_instruction_opcode_not_verified'));
  }
});
test('legacy IOP report has unavailable instruction evidence without inventing EE provenance', () => {
  assert.equal(parseExceptionReport(iopReport()).instruction_evidence.status, 'unavailable');
});
test('read wait releases command ownership so another caller can resume and trigger capture', async t => {
  let captured = false;
  const { client } = await workflowFixture(t, request => {
    if (request.cmd === 'exception_watch_status') return captured ? state('captured', report()) : state();
    if (request.cmd === 'resume') { captured = true; return { ok: true }; }
  });
  const pending = readExceptionReport(client, id, 1000);
  await delay(20); await client.resume(); const result = await pending;
  assert.equal(result.state, 'captured'); assert.equal(result.report.complete, true);
});
test('wait timeout and cancellation leave native watch untouched; terminal states are explicit', async t => {
  let current = 'armed';
  const { client, mock } = await workflowFixture(t, request => request.cmd === 'exception_watch_status' ? state(current) : undefined);
  assert.equal((await readExceptionReport(client, id, 0)).timed_out, true);
  const abort = new AbortController(), pending = readExceptionReport(client, id, 1000, abort.signal);
  await delay(20); abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
  for (current of ['expired', 'cancelled', 'vm_changed', 'vm_stopped']) {
    const result = await readExceptionReport(client, id); assert.equal(result.state, current); assert.equal(result.timed_out, false);
  }
  assert.ok(mock.requests.every(r => r.cmd === 'exception_watch_status'));
});
test('rejects foreign ID, inconsistent captured state and report from another epoch', async t => {
  let value = state('armed', null, other);
  const { client } = await workflowFixture(t, request => request.cmd === 'exception_watch_status' ? value : undefined);
  await assert.rejects(readExceptionReport(client, id), /Inconsistent/);
  value = state('captured'); await assert.rejects(readExceptionReport(client, id), /Inconsistent/);
  const stale = report(); stale.execution_epoch++; value = state('captured', stale);
  await assert.rejects(readExceptionReport(client, id), /identity/);
});
test('saved reports use unique directories and preserve decoded PNG without embedding its base64', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-exception-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const original = report(), result = { ...state('captured', parseExceptionReport(original)), timed_out: false };
  const a = await saveExceptionReport(result, base), b = await saveExceptionReport(result, base);
  assert.notEqual(a.artifacts.directory, b.artifacts.directory);
  assert.deepEqual(await fs.readFile(a.artifacts.screenshot), Buffer.from(original.context.screenshot.data, 'base64'));
  const stored = JSON.parse(await fs.readFile(a.artifacts.report, 'utf8'));
  assert.equal(stored.report.context.screenshot.data, ''); assert.equal(stored.report.core.exception_code, 9);
  assert.equal(original.context.screenshot.data.length > 0, true);
});
