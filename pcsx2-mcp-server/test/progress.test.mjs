import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { progressOptions, parseProgressReport } from '../dist/progress.js';
import { startProgressWatch, readProgressReport, saveProgressReport } from '../dist/progress-tools.js';
import { workflowFixture, capabilities } from './workflow-fixtures.mjs';
import { contextResponse, history } from './fixtures.mjs';

const id = 'a'.repeat(32), other = 'b'.repeat(32);
const caps = { ...capabilities, execution_epoch: 7, features: ['ee_progress_watch'] };
const criterion = { heartbeat_address: '0x00101000', heartbeat_mask: '0xffffffff', active_address: null,
  active_mask: '0xffffffff', active_value: '0x00000001', sample_interval_ms: 100, stall_ms: 300, max_sample_gap_ms: 400, max_samples: 8 };
const options = { heartbeat_address: criterion.heartbeat_address, stall_ms: 300, max_samples: 8 };
const hex = n => '0x' + n.toString(16).padStart(8, '0');
function report() {
  const context = contextResponse(); context.elf = caps.elf;
  return { watch_id: id, cpu: 'ee', observation: 'configured_heartbeat_stall', timestamp_ms: 1000,
    session: 1, execution_epoch: 7, elf: caps.elf, elf_crc: caps.elf_crc, criterion: { ...criterion },
    unchanged_ms: 400, unchanged_intervals: 4, stop_pc: context.status.data.pc, stop_cycles: hex(context.status.data.cycles),
    screenshot_requested: true, context_matches_stop: true, total_samples: 5, samples_dropped: 0,
    samples: Array.from({ length: 5 }, (_, i) => ({ timestamp_ms: 500 + i * 100, elapsed_ms: i * 100,
      pc: '0x00100000', cycles: hex(i * 100 + 1), heartbeat: '0x00000007', active_value: null, phase: i ? 'unchanged' : 'baseline' })),
    memory: { code: { address: '0x00100000', length: 64, valid: true, hex: '00'.repeat(64) },
      stack: { address: '0x00101000', length: 256, valid: true, hex: 'ab'.repeat(256) } },
    events: history('events', [{ sequence: 1, timestamp_ms: 1000, type: 'progress_stall', cpu: 'ee', pc: context.status.data.pc, detail: id }]), context };
}
function state(phase = 'armed', value = null, watch_id = id) {
  return { ok: true, watch_id, cpu: 'ee', state: phase, active: ['armed', 'capturing'].includes(phase),
    session: 1, execution_epoch: 7, elf: caps.elf, elf_crc: caps.elf_crc, criterion: { ...criterion },
    unchanged_ms: value?.unchanged_ms ?? 0, total_samples: value?.total_samples ?? 0, report: value };
}
test('progress requires aligned canonical RAM, nonempty masks and bounded timing/samples', () => {
  assert.equal(progressOptions.parse({ heartbeat_address: '0x00101000' }).heartbeat_mask, 0xffffffff);
  for (const bad of [{ heartbeat_address: '0x10000000' }, { heartbeat_address: '0x00101001' }, { heartbeat_address: '0x02000000' },
    { active_address: '0x80001000' }, { heartbeat_mask: 0 }, { active_mask: 0 }, { active_mask: 1, active_value: 2 },
    { sample_interval_ms: 49 }, { sample_interval_ms: 1000, stall_ms: 2999 }, { stall_ms: 60001 }, { max_samples: 65 }, { timeout_ms: 300001 }])
    assert.throws(() => progressOptions.parse({ ...options, ...bad }));
});
test('native progress start passes VM identity/criterion without resuming; old capability refuses before mutation', async t => {
  let supported = true;
  const { client, mock } = await workflowFixture(t, request => {
    if (request.cmd === 'capabilities') return supported ? caps : capabilities;
    if (request.cmd === 'progress_watch_start') return state('armed', null, request.watch_id);
  });
  const started = await startProgressWatch(client, options);
  assert.equal(started.resumes_vm, false);
  const sent = mock.requests.find(r => r.cmd === 'progress_watch_start');
  assert.equal(sent.expected_execution_epoch, 7); assert.equal(sent.expected_process_id, 42);
  assert.equal(sent.heartbeat_mask, 0xffffffff); assert.equal(sent.max_samples, 8);
  assert.ok(!mock.requests.some(r => ['pause', 'resume', 'write_memory', 'set_breakpoint'].includes(r.cmd)));
  supported = false; const before = mock.requests.length;
  await assert.rejects(startProgressWatch(client, options), /ee_progress_watch/);
  assert.equal(mock.requests.length, before + 1);
});
test('native refusal preserves other watches; uncertain start cancels only its generated ID and reports failed cleanup', async t => {
  let reject = true, failCleanup = false;
  const { client, mock } = await workflowFixture(t, request => {
    if (request.cmd === 'capabilities') return caps;
    if (request.cmd === 'progress_watch_start') return reject ? { ok: false, error: 'active watch' } : state('armed', null, other);
    if (request.cmd === 'progress_watch_cancel') return failCleanup ? { ok: false, error: 'lost watch' } : state('cancelled', null, request.watch_id);
  });
  await assert.rejects(startProgressWatch(client, options), /active watch/);
  assert.equal(mock.requests.filter(r => r.cmd === 'progress_watch_cancel').length, 0);
  reject = false; failCleanup = true;
  await assert.rejects(startProgressWatch(client, options), e => !!e.cleanup?.pending_watch_id);
  assert.equal(mock.requests.at(-1).watch_id, mock.requests.findLast(r => r.cmd === 'progress_watch_start').watch_id);
});
test('progress report verifies advancing-cycle heartbeat streak and preserved paused context', () => {
  const parsed = parseProgressReport(report()); assert.equal(parsed.complete, true); assert.equal(parsed.streak_fully_retained, true);
  assert.match(parsed.interpretation, /Cause is undetermined/);
  for (const mutate of [r => r.unchanged_ms++, r => r.unchanged_intervals = 2, r => r.samples[4].heartbeat = '0x00000008',
    r => r.samples[3].cycles = r.samples[2].cycles, r => r.samples[2].phase = 'paused', r => r.samples[2].phase = 'expected_wait',
    r => r.samples[4].elapsed_ms = 1000, r => r.samples[4].elapsed_ms = 200, r => r.context.cpu = 'iop',
    r => r.context.status.data.pc = '0x00100004', r => r.stop_cycles = '0x00000000', r => r.events.session++,
    r => r.memory.code.address = '0x10000000', r => r.samples_dropped++, r => r.criterion.max_sample_gap_ms++]) {
    const value = report(); mutate(value); assert.throws(() => parseProgressReport(value));
  }
  const gated = report(); gated.criterion.active_address = '0x00101004';
  assert.throws(() => parseProgressReport(gated));
  const masked = report(); masked.criterion.heartbeat_mask = '0x00000001';
  assert.throws(() => parseProgressReport(masked), /mask/);
});
test('bounded ring truncation and missing frame remain explicit partial evidence, never a crash classifier', () => {
  const value = report(); value.samples[0].phase = 'unchanged'; value.total_samples = 20; value.samples_dropped = 15;
  value.unchanged_ms = 1900; value.unchanged_intervals = 19;
  value.context.screenshot = { ok: false, error: 'No GS frame' };
  const parsed = parseProgressReport(value);
  assert.equal(parsed.complete, false); assert.equal(parsed.streak_fully_retained, false);
  assert.deepEqual(parsed.partial_reasons, ['No GS frame', 'progress_streak_start_not_retained']);
});
test('read wait allows another request to resume; report identity/criterion mismatches are rejected', async t => {
  let value = state();
  const { client } = await workflowFixture(t, request => {
    if (request.cmd === 'progress_watch_status') return value;
    if (request.cmd === 'resume') { value = state('captured', report()); return { ok: true }; }
  });
  const pending = readProgressReport(client, id, 1000); await delay(20); await client.resume();
  assert.equal((await pending).report.complete, true);
  for (const mutate of [s => s.report.execution_epoch++, s => s.report.watch_id = other,
    s => s.criterion.heartbeat_mask = '0x0000ffff', s => s.total_samples++, s => s.watch_id = other, s => s.active = true]) {
    value = state('captured', report()); mutate(value); await assert.rejects(readProgressReport(client, id));
  }
});
test('wait cancellation/timeout and native terminal states never resume or cancel the watch', async t => {
  let value = state(); const { client, mock } = await workflowFixture(t, r => r.cmd === 'progress_watch_status' ? value : undefined);
  assert.equal((await readProgressReport(client, id)).timed_out, true);
  const controller = new AbortController(), pending = readProgressReport(client, id, 1000, controller.signal);
  await delay(20); controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  for (const phase of ['cancelled', 'expired', 'vm_changed', 'vm_stopped', 'memory_unavailable']) {
    value = state(phase); assert.equal((await readProgressReport(client, id)).timed_out, false);
  }
  assert.ok(mock.requests.every(r => r.cmd === 'progress_watch_status'));
});
test('saved progress artifacts are unique and preserve PNG while removing base64 from saved JSON', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcsx2-progress-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const original = report(), result = { ...state('captured', parseProgressReport(original)), timed_out: false };
  const first = await saveProgressReport(result, directory), second = await saveProgressReport(result, directory);
  assert.notEqual(first.artifacts.directory, second.artifacts.directory);
  assert.deepEqual(await fs.readFile(first.artifacts.screenshot), Buffer.from(original.context.screenshot.data, 'base64'));
  assert.equal(JSON.parse(await fs.readFile(first.artifacts.report, 'utf8')).report.context.screenshot.data, '');
  assert.ok(original.context.screenshot.data.length);
});
