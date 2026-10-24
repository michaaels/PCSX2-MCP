// Verifies retained incident evidence; passing this never accepts playback audio.
// node test/verify-sms-audio-incident.mjs <measured-playback.json> <sif2-trace.json> <new-receipt.json>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
assert.equal(process.argv.length, 5);
const [measuredPath, tracePath, output] = process.argv.slice(2).map(p => path.resolve(p));
const digest = b => createHash('sha256').update(b).digest('hex');
const measuredBytes = await fs.readFile(measuredPath), tracedBytes = await fs.readFile(tracePath);
const measured = JSON.parse(measuredBytes), traced = JSON.parse(tracedBytes), checks = [];
const passed = text => { checks.push(text); console.log('PASS '+text); };
assert.equal(measured.kind, 'sms_known_clip_audio'); assert.equal(traced.kind, measured.kind);
assert.equal(measured.passed, false); assert.equal(traced.passed, false);
assert.equal(measured.elf_sha256, traced.elf_sha256); assert.equal(measured.fixture.reference_sha256, traced.fixture.reference_sha256);
assert.notEqual(measured.boot_id, traced.boot_id, 'Independent runs must not be presented as one execution');
assert.ok(measured.reference.tone.every(t => t.frequency_hz === 440 && t.tone_power_fraction > .7));
passed('same retained ELF/known 440 Hz reference, with separate boot identities and failed playback acceptance');
const run = measured.runs[0]; assert.equal(measured.runs.length, 1);
assert.equal(run.published.sha256, measured.fixture.reference_sha256);
assert.equal(digest(await fs.readFile(run.published.path)), run.published.sha256);
assert.equal(digest(await fs.readFile(measured.reference.path)), measured.fixture.reference_sha256);
passed('actual Bridge-published MPG matches the complete pinned reference bytes');
const artifacts = [];
for (const [capture, analysis] of [[run.capture, run.measurement], [run.late_capture, run.late_measurement]]) {
  assert.equal(capture.state, 'closed'); assert.equal(capture.reason, 'frame_limit'); assert.equal(capture.video_frames, 180);
  assert.equal(capture.artifact.verified, true); assert.equal(analysis.source.sha256, capture.artifact.sha256);
  const bytes = await fs.readFile(capture.path); assert.equal(digest(bytes), capture.artifact.sha256);
  const pcm = await fs.readFile(analysis.pcm.path); assert.equal(digest(pcm), analysis.pcm.sha256);
  assert.ok(pcm.length >= 2 * 48000 * 8); assert.ok(pcm.every(b => b === 0));
  assert.ok(analysis.metrics.channel_metrics.every(c => c.rms_amplitude === 0 && c.exact_zero_samples === analysis.metrics.frame_count));
  artifacts.push({ mp4_path: capture.path, mp4_sha256: capture.artifact.sha256, pcm_path: analysis.pcm.path, pcm_sha256: analysis.pcm.sha256 });
}
passed('both fresh 180-frame native captures retain verified all-zero stereo PCM and original hashes');
const states = [run.state_after_capture, run.state_after_additional_5s, run.state_after_late_capture];
for (const state of states) {
  assert.ok(state.status.paused); assert.equal(state.epoch, measured.identity.execution_epoch);
  assert.equal(state.values.m_AudioTime, states[0].values.m_AudioTime); assert.equal(state.values.m_VideoTime, states[0].values.m_VideoTime);
  assert.equal(state.values.m_AudioIdx, 1); assert.equal(state.values.m_VideoIdx, 0);
  const raw = Buffer.from(state.raw_hex, 'hex'); assert.equal(raw.length, measured.player_object.size);
  for (const f of measured.player_object.fields.filter(f => ['m_AudioTime','m_VideoTime'].includes(f.name)))
    assert.equal(raw.readBigInt64LE(f.offset).toString(), state.values[f.name]);
}
assert.notEqual(states[0].values.m_AudioTime, '0'); assert.notEqual(states[0].values.m_VideoTime, '0');
assert.equal(new Set(states.map(s => s.status.cycles)).size, 3);
passed('DWARF-backed nonzero player clocks stop changing across three paused samples while CPU cycle observations differ');
const join = run.player_enter_join;
assert.equal(join.console.event, 'player_enter'); assert.equal(join.bridge.event, 'player_enter');
assert.equal(join.bridge.bootId, measured.boot_id); assert.equal(join.bridge.buildId, measured.build_id);
assert.equal(join.console.client_session, run.player_entry.playback_session); assert.equal(join.bridge.sessionId, join.console.client_session);
assert.equal(join.bridge.sequence, join.console.client_sequence);
assert.equal(run.milestones.length, 4); assert.ok(run.milestones.every(m => m.reached));
passed('actual player-enter console/Bridge fields and four source milestones belong to the measured playback run');
const sif2 = traced.runs[0].sif2_trace; assert.equal(sif2.length, 2);
assert.equal(sif2[0].label, 'before_header_ack_wait'); assert.equal(sif2[0].reached, true);
assert.equal(sif2[1].label, 'after_header_ack_following_marker'); assert.equal(sif2[1].reached, false);
assert.equal(sif2[1].wait_timeout_ms, 10000);
assert.ok(sif2[0].wait_call); assert.ok(sif2[0].wait_call.semaphore_id >= 0);
assert.equal(sif2[0].wait_call.target, traced.runs[0].sif2_metadata.wait_sema_address);
assert.ok(sif2[1].breakpoint.addresses.some(p => Number(p) === Number(sif2[0].wait_call.return_pc) + 4));
assert.equal(Buffer.from(sif2[0].instruction_hex, 'hex').readUInt32LE(12) >>> 26, 15);
passed('verified runtime semaphore load/JAL to WaitSema; a source marker one LUI after return was not observed within the trace deadline');
for (const file of [measuredPath, tracePath]) {
  const services = JSON.parse(await fs.readFile(path.resolve(path.dirname(file), '../services.json')));
  assert.equal(services.passed, false); assert.equal(services.owned_services_stopped, true); assert.equal(services.jellyfin.owned, false);
  const validation = JSON.parse(await fs.readFile(path.join(path.dirname(file), 'validation.json')));
  assert.equal(validation.passed, false); assert.equal(validation.owned_emulator_stopped, true);
}
passed('failed playback runs remain failed, owned services/emulators closed and external Jellyfin retained');
const receipt = { kind: 'sms_audio_stall_evidence_validation', diagnostic_evidence_verified: true, playback_audio_accepted: false,
  created_at: new Date().toISOString(), build_id: measured.build_id, elf_sha256: measured.elf_sha256,
  measured_boot_id: measured.boot_id, trace_boot_id: traced.boot_id, checks,
  reports: [{ path: measuredPath, sha256: digest(measuredBytes) }, { path: tracePath, sha256: digest(tracedBytes) }], artifacts,
  observation: 'zero_captured_PCM_and_stalled_player_clocks_separate_trace_waits_for_first_SIF2_header_ack',
  root_cause: 'not_established', physical_ps2_or_e11_causality: 'not_established' };
await fs.writeFile(output, JSON.stringify(receipt, null, 2)+'\n', { flag: 'wx', mode: 0o600 });
