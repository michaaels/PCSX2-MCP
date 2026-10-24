// Incident evidence validation only: this must never accept failed audio playback.
// node test/verify-sms-sif-evidence.mjs <measured.json> <trace.json> <new-receipt.json>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { sifIdentity, parseSifSnapshot, describeSifSnapshot } from '../dist/sif-state.js';

assert.equal(process.argv.length, 5);
const [measuredPath, tracePath, output] = process.argv.slice(2).map(p => path.resolve(p));
const bytes = await Promise.all([measuredPath, tracePath].map(p => fs.readFile(p)));
const [measured, traced] = bytes.map(b => JSON.parse(b)), checks = [];
const passed = text => { checks.push(text); console.log('PASS '+text); };
assert.equal(measured.kind, 'sms_known_clip_audio'); assert.equal(traced.kind, measured.kind);
assert.equal(measured.passed, false); assert.equal(traced.passed, false);
assert.notEqual(measured.boot_id, traced.boot_id);
assert.equal(measured.elf_sha256, traced.elf_sha256);
assert.equal(measured.fixture.reference_sha256, traced.fixture.reference_sha256);
passed('failed measured playback and separate header-wait trace retain distinct boots and the same pinned ELF/clip');

function validate(report, snapshot) {
  const identity = sifIdentity.parse(report.identity);
  // Earlier IOP module/lifetime boundaries are historical samples, not current module bindings.
  assert.ok(snapshot.iop_reset_epoch <= identity.iop_reset_epoch);
  assert.ok(snapshot.iop_lifetime_epoch <= identity.iop_lifetime_epoch);
  const expected = { ...identity, iop_reset_epoch: snapshot.iop_reset_epoch, iop_lifetime_epoch: snapshot.iop_lifetime_epoch };
  const raw = parseSifSnapshot(snapshot, expected);
  assert.deepEqual(describeSifSnapshot(raw), snapshot);
  return snapshot;
}
const run = measured.runs[0], trace = traced.runs[0];
const measuredStates = ['sif_at_entry', 'sif_after_capture', 'sif_after_additional_5s', 'sif_after_late_capture']
  .map(k => validate(measured, run[k]));
const before = validate(traced, trace.sif2_trace[0].sif), failed = validate(traced, traced.failure_sif);
assert.equal(trace.sif2_trace[0].reached, true); assert.equal(trace.sif2_trace[1].reached, false);
assert.equal(trace.sif2_trace[1].wait_timeout_ms, 10000);
passed('all six snapshots validate protocol, ordering, raw/decoded consistency and their own run identity/epochs');

for (const snapshot of [...measuredStates.slice(1), failed]) {
  const entries = snapshot.writes.entries;
  assert.equal(snapshot.writes.dropped, 0);
  const high = entries.find(w => w.address === '0x1f8010a6' && w.bits === 16);
  assert.ok(high); assert.equal(high.value, '0x00000001');
  assert.equal(high.word_before, '0x00000008'); assert.equal(high.word_after, high.word_before);
  const low = entries.find(w => w.sequence === high.sequence - 1);
  assert.equal(low.address, '0x1f8010a4'); assert.equal(low.bits, 16); assert.equal(low.value, '0x00000008');
  const next = entries.find(w => w.sequence === high.sequence + 1);
  assert.equal(next.address, '0x1f8010a8'); assert.equal(next.bits, 32); assert.equal(next.word_after, '0x01000200');
  const comparison = snapshot.write_comparisons.find(w => w.sequence === high.sequence);
  assert.equal(comparison.simple_merge_word, '0x00010008'); assert.equal(comparison.matches_simple_merge, false);
}
assert.ok(!before.writes.entries.some(w => w.address === '0x1f8010a6'));
passed('both executions record low BCR write, unchanged high-half BCR write and following CHCR start; no history loss');

const stalled = measuredStates.slice(1);
for (const snapshot of [...stalled, failed]) {
  const s = snapshot.channels[2];
  assert.equal(s.ee.chcr, '0x00000101'); assert.equal(s.ee.qwc, '0x00000002');
  assert.equal(s.iop_backing.chcr, '0x01000200'); assert.equal(s.iop_backing.bcr, '0x00000008');
  assert.equal(s.backend.ee_busy, true); assert.equal(s.backend.iop_busy, false);
  assert.equal(s.backend.fifo_words, 0);
  assert.equal(snapshot.pgif.data_fifo.words, 0); assert.equal(snapshot.pgif.command_fifo.words, 0);
  assert.equal(snapshot.pgif.to_iop_active, true);
}
for (const snapshot of stalled.slice(1)) {
  assert.deepEqual(snapshot.channels[2], stalled[0].channels[2]);
  assert.deepEqual(snapshot.pgif, stalled[0].pgif); assert.deepEqual(snapshot.writes, stalled[0].writes);
}
passed('SIF2/PGIF backing state and history remain unchanged across three measured pauses with a five-second running interval');

for (const [sif, state] of [[run.sif_at_entry, run.state_at_entry], [run.sif_after_capture, run.state_after_capture],
  [run.sif_after_additional_5s, run.state_after_additional_5s], [run.sif_after_late_capture, run.state_after_late_capture],
  [before, trace.sif2_trace[0].player_state]]) {
  assert.equal(Number(sif.sample.ee_pc), Number(state.status.pc));
  assert.equal(Number(sif.sample.ee_cycles), state.status.cycles); assert.equal(state.status.paused, true);
}
passed('snapshot CPU samples match the separately retained paused player observations without combining boots');

await fs.writeFile(output, JSON.stringify({ kind: 'sms_sif_observation_validation',
  diagnostic_evidence_verified: true, playback_audio_accepted: false, root_cause: 'not_established',
  physical_ps2_validation: 'not_performed', created_at: new Date().toISOString(), checks,
  reports: [measuredPath, tracePath].map((p, i) => ({ path: p, sha256: createHash('sha256').update(bytes[i]).digest('hex') })),
  observation: 'high_half_BCR_write_does_not_merge_into_backing_storage_while_SIF2_and_PGIF_wait',
}, null, 2)+'\n', { flag: 'wx', mode: 0o600 });
