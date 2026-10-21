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
