import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { memoryWatchOptions, memoryWatchState, memoryWatchList } from '../dist/memory-watch.js';
import { startMemoryWatch, waitMemoryWatch } from '../dist/memory-watch-tools.js';
import { workflowFixture, capabilities } from './workflow-fixtures.mjs';

const id = 'a'.repeat(32), other = 'b'.repeat(32);
const caps = { ...capabilities, execution_epoch: 7, iop_reset_epoch: 3, features: ['memory_change_watch'] };
const options = { address: '0x00101000' };
function state(phase = 'armed', watch_id = id, cpu = 'ee') {
  return { ok: true, watch_id, cpu, state: phase, active: phase === 'armed', session: 1, execution_epoch: 7,
    iop_reset_epoch: 3, elf: caps.elf, elf_crc: caps.elf_crc, address: options.address, size: 4, mask: '0xffffffff',
    sample_interval_ms: 100, timeout_ms: 30000, pause_on_change: false, total_samples: 0, baseline_count: 0,
    sampling_cpu_ns: 0, observation: 'sampled_memory_change', writer_pc: null, change: null };
}
function changed() {
  return { ...state('changed'), total_samples: 2, baseline_count: 1, sampling_cpu_ns: 800,
    change: { previous: { timestamp_ms: 1000, elapsed_ms: 100, sample_pc: '0x00100000', cycles: '0x00000001', raw: '0x80000100', masked: '0x80000100' },
      current: { timestamp_ms: 1100, elapsed_ms: 200, sample_pc: '0x00100004', cycles: '0x00000002', raw: '0x80000200', masked: '0x80000200' } } };
}
test('observer rejects aliases, MMIO, ROM, crossed extents, unaligned widths, oversized/empty masks and timing bounds', () => {
  assert.equal(memoryWatchOptions.parse(options).size, 4);
  for (const bad of [{ address: '0x80001000' }, { address: '0x10000000' }, { address: '0x1fc00000' },
    { address: '0x01ffffff' }, { address: '0x00100001', size: 2 }, { cpu: 'iop', address: '0x00200000' },
    { size: 3 }, { size: 1, mask: 256 }, { size: 2, mask: 65536 }, { mask: 0 }, { mask: -1 },
    { sample_interval_ms: 49 }, { sample_interval_ms: 1001 }, { timeout_ms: 99 }, { timeout_ms: 300001 }])
    assert.throws(() => memoryWatchOptions.parse({ ...options, ...bad }));
  memoryWatchOptions.parse({ cpu: 'iop', address: '0x001fffff', size: 1 });
});
test('start passes CPU, VM and IOP reset identities; old capability refuses before mutation, without resume', async t => {
  let supported = true;
  const { client, mock } = await workflowFixture(t, r => {
    if (r.cmd === 'capabilities') return supported ? caps : capabilities;
    if (r.cmd === 'memory_watch_start') return state('armed', r.watch_id, r.cpu);
  });
  assert.equal((await startMemoryWatch(client, { ...options, cpu: 'iop' })).resumes_vm, false);
  const sent = mock.requests.find(r => r.cmd === 'memory_watch_start');
  assert.equal(sent.expected_iop_reset_epoch, 3); assert.equal(sent.expected_execution_epoch, 7);
  assert.equal(sent.expected_process_id, 42); assert.equal(sent.pause_on_change, false);
  supported = false; const before = mock.requests.length;
  await assert.rejects(startMemoryWatch(client, options), /memory_change_watch/);
  assert.equal(mock.requests.length, before + 1);
  assert.ok(mock.requests.every(r => ['capabilities', 'memory_watch_start'].includes(r.cmd)));
});
test('native refusal does not cancel other IDs; uncertain start cleans only its generated watch', async t => {
  let reject = true;
  const { client, mock } = await workflowFixture(t, r => {
    if (r.cmd === 'capabilities') return caps;
    if (r.cmd === 'memory_watch_start') return reject ? { ok: false, error: 'capacity reached' } : state('armed', other);
    if (r.cmd === 'memory_watch_cancel') return { ok: false, error: 'connection lost' };
  });
  await assert.rejects(startMemoryWatch(client, options), /capacity/);
  assert.equal(mock.requests.filter(r => r.cmd === 'memory_watch_cancel').length, 0);
  reject = false;
  await assert.rejects(startMemoryWatch(client, options), e => !!e.cleanup?.pending_watch_id);
  assert.equal(mock.requests.at(-1).watch_id, mock.requests.findLast(r => r.cmd === 'memory_watch_start').watch_id);
});
test('immutable change pair checks width, masks, advancing cycles, gap, state and explicitly unknown writer', () => {
  assert.equal(memoryWatchState.parse(changed()).writer_pc, null);
  for (const mutate of [s => s.writer_pc = '0x00100000', s => s.change.current.masked = s.change.previous.masked,
    s => s.change.current.cycles = s.change.previous.cycles, s => s.change.current.elapsed_ms = 501,
    s => s.change.current.elapsed_ms = 100, s => s.change.current.elapsed_ms = 30000,
    s => s.mask = '0x000000ff', s => s.size = 1, s => s.total_samples = 1, s => s.baseline_count = 0,
    s => s.state = 'armed', s => s.active = true, s => s.change = null]) {
    const value = changed(); mutate(value); assert.throws(() => memoryWatchState.parse(value));
  }
});
test('wait releases connection for resume, accepts frozen result without consulting changed capabilities', async t => {
  let value = state(); const { client, mock } = await workflowFixture(t, r => {
    if (r.cmd === 'memory_watch_status') return value;
    if (r.cmd === 'resume') { value = changed(); return { ok: true }; }
  });
  const pending = waitMemoryWatch(client, id, 1000); await delay(20); await client.resume();
  assert.equal((await pending).state, 'changed');
  assert.ok(!mock.requests.some(r => r.cmd === 'capabilities'));
  value = { ...changed(), watch_id: other }; await assert.rejects(waitMemoryWatch(client, id), /ID/);
});
test('wait timeout/cancellation leaves observer armed; terminals do not resume or cancel', async t => {
  let value = state(); const { client, mock } = await workflowFixture(t, r => r.cmd === 'memory_watch_status' ? value : undefined);
  assert.equal((await waitMemoryWatch(client, id)).timed_out, true);
  const controller = new AbortController(), pending = waitMemoryWatch(client, id, 1000, controller.signal);
  await delay(10); controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  for (const phase of ['expired', 'cancelled', 'vm_changed', 'vm_stopped', 'cpu_reset', 'memory_unavailable']) {
    value = state(phase); assert.equal((await waitMemoryWatch(client, id)).timed_out, false);
  }
  assert.ok(mock.requests.every(r => r.cmd === 'memory_watch_status'));
});
test('bounded list rejects duplicate IDs and excess retained observers', async t => {
  let value = { ok: true, capacity: 16, watches: [state(), changed()] };
  assert.throws(() => memoryWatchList.parse(value));
  value.watches[1].watch_id = other; memoryWatchList.parse(value);
  const { client } = await workflowFixture(t, () => value);
  assert.equal((await client.listMemoryWatches()).watches.length, 2);
  value.watches = Array.from({ length: 17 }, (_, i) => state('armed', i.toString(16).padStart(32, '0')));
  await assert.rejects(client.listMemoryWatches());
});
