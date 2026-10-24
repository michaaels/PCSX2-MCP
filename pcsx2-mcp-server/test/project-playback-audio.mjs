// SMS known-clip recipe: actual controller/UDPFS/player path, read-only guest inspection.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { measureAudioPcm, runAudioProcess } from '../dist/audio-measurement.js';
import { traceSif2 } from './sms-sif2-trace.mjs';

const hash = b => createHash('sha256').update(b).digest('hex');
const absolute = z.string().refine(path.isAbsolute), sha = z.string().regex(/^[a-f0-9]{64}$/);
export const playbackFixture = z.object({ library_id: z.string().regex(/^[a-f0-9]{32}$/), item_id: z.string().regex(/^[a-f0-9]{32}$/),
  reference_path: absolute, reference_sha256: sha, repetitions: z.number().int().min(1).max(3).default(2),
  capture_frames: z.number().int().min(60).max(240).default(180),
  input_frames: z.number().int().min(6).max(30).default(12),
  trace_sif2: z.boolean().default(false),
  sif_snapshots: z.boolean().default(false),
}).strict();

/** A fixture-only tone-presence measurement, never a general sound-quality assertion. */
export function toneEvidence(pcm, expectedFrequency) {
  assert.equal(pcm.length % 8, 0, 'Complete interleaved stereo frames required');
  assert.ok(expectedFrequency === undefined || Number.isFinite(expectedFrequency) && expectedFrequency > 0 && expectedFrequency < 24000);
  const count = Math.min(pcm.length / 8, 48000), result = [];
  assert.ok(Number.isInteger(count) && count > 0 && pcm.length <= 3840000);
  for (let c = 0; c < 2; c++) {
    let sum = 0, squares = 0;
    for (let i = 0; i < count; i++) { const x = pcm.readFloatLE(i * 8 + c * 4); assert.ok(Number.isFinite(x)); sum += x; squares += x * x; }
    const mean = sum / count, variance = Math.max(0, squares / count - mean * mean);
    const power = (hz, samples = count) => {
      const k = 2 * Math.cos(2 * Math.PI * hz / 48000); let a = 0, b = 0;
      for (let i = 0; i < samples; i++) { const next = pcm.readFloatLE(i * 8 + c * 4) - mean + k * a - b; b = a; a = next; }
      return Math.max(0, a * a + b * b - k * a * b) / (samples * samples);
    };
    let frequency = expectedFrequency, maximum = frequency === undefined ? 0 : power(frequency);
    if (frequency === undefined) {
      // A one-second coherent tone can be exactly orthogonal to every coarse
      // bin. Use a short overlapping coarse search, then refine on full PCM.
      for (let hz = 100; hz <= 2000; hz += 10) { const p = power(hz, Math.min(4096, count)); if (p > maximum) { frequency = hz; maximum = p; } }
      const coarse = frequency;
      if (coarse !== undefined) {
        maximum = power(coarse);
        for (let hz = coarse - 10; hz <= coarse + 10; hz++) { const p = power(hz); if (p > maximum) { frequency = hz; maximum = p; } }
      }
    }
    result.push({ channel: c, sample_count: count, rms_amplitude: Math.sqrt(squares / count),
      frequency_hz: frequency ?? null, tone_power_fraction: variance ? 2 * maximum / variance : 0,
      scope: 'first_up_to_one_decoded_second_frequency_projection_not_temporal_alignment_or_quality' });
  }
  return result;
}

export async function capturePlaybackAudio({ call, inspector, manifest, manifestPath, elf, output, options, journal, fixturePath, bootId, passed }) {
  assert.ok(path.isAbsolute(fixturePath));
  const rawFixture = await fs.readFile(fixturePath); assert.ok(rawFixture.length < 16384);
  const fixture = playbackFixture.parse(JSON.parse(rawFixture));
  const report = { kind: 'sms_known_clip_audio', format_version: 1, passed: false, fixture_sha256: hash(rawFixture), fixture,
    build_id: manifest.build_id, elf_sha256: manifest.elf_sha256, boot_id: bootId, runs: [], actions: [],
    guest_code_register_data_writes: false, instrumentation: 'pause_read_only_DWARF_objects_controller_and_source_breakpoint',
    audio_quality: 'not_evaluated', listening: 'not_performed', av_sync: 'not_measured', physical_ps2: 'not_tested' };
  const groups = new Set();
  try {
    report.recipe_sources = [];
    for (const relative of ['project-playback-audio.mjs', 'sms-sif2-trace.mjs', 'fixtures/sms-incident-objects.py',
      'fixtures/sms-playback-objects.py', 'fixtures/sms-player-state.py', 'fixtures/sms-sif2-objects.py']) {
      const bytes = await fs.readFile(fileURLToPath(new URL('./'+relative, import.meta.url)));
      report.recipe_sources.push({ path: relative, sha256: hash(bytes) });
    }
    assert.ok((await fs.stat(fixture.reference_path)).size <= 16777216);
    const reference = await fs.readFile(fixture.reference_path); assert.ok(reference.length <= 16777216);
    assert.equal(hash(reference), fixture.reference_sha256, 'Known published clip SHA mismatch');
    const probe = JSON.parse((await runAudioProcess(process.env.PCSX2_FFPROBE || 'ffprobe', ['-v', 'error',
      '-protocol_whitelist', 'file', '-f', 'mpeg', '-show_entries', 'stream=codec_type,codec_name,sample_rate,channels',
      '-of', 'json', fixture.reference_path], 65536)).toString('utf8'));
    const audioTracks = probe.streams.filter(s => s.codec_type === 'audio');
    assert.equal(audioTracks.length, 1); assert.equal(audioTracks[0].sample_rate, '48000'); assert.equal(audioTracks[0].channels, 2);
    const pcm = await runAudioProcess(process.env.PCSX2_FFMPEG || 'ffmpeg', ['-nostdin', '-xerror', '-v', 'error',
      '-protocol_whitelist', 'file,pipe', '-f', 'mpeg', '-threads', '1', '-i', fixture.reference_path,
      '-map', '0:a:0', '-vn', '-threads', '1', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], 3840000);
    report.reference = { path: fixture.reference_path, sha256: fixture.reference_sha256,
      probe, metrics: await measureAudioPcm(pcm), tone: toneEvidence(pcm) };
    assert.ok(report.reference.tone.every(t => t.frequency_hz && t.tone_power_fraction > .7), 'Recipe requires a known sustained tone in both channels');
    const python = process.env.PCSX2_DWARF_PYTHON ?? fileURLToPath(new URL(
      process.platform === 'win32' ? '../.venv-dwarf/Scripts/python.exe' : '../.venv-dwarf/bin/python', import.meta.url));
    assert.ok(path.isAbsolute(python));
    const { stdout } = await promisify(execFile)(python, ['-I', fileURLToPath(new URL('./fixtures/sms-playback-objects.py', import.meta.url)), elf, manifest.elf_sha256],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 1048576, windowsHide: true });
    const metadata = JSON.parse(stdout); assert.equal(metadata.elf_sha256, manifest.elf_sha256); assert.equal(metadata.objects.length, 9);
    report.objects = metadata.objects;
    const playerMetadata = JSON.parse((await promisify(execFile)(python,
      ['-I', fileURLToPath(new URL('./fixtures/sms-player-state.py', import.meta.url)), elf, manifest.elf_sha256],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 1048576, windowsHide: true })).stdout);
    assert.equal(playerMetadata.elf_sha256, manifest.elf_sha256); assert.equal(playerMetadata.fields.length, 12);
    report.player_object = playerMetadata;
    const objects = Object.fromEntries(metadata.objects.map(o => [o.name, o]));
    const identity = await inspector.getCapabilities(); report.identity = identity;
    async function checkIdentity() {
      const caps = await inspector.getCapabilities();
      for (const key of ['process_id', 'session', 'execution_epoch', 'elf', 'elf_crc']) assert.equal(caps[key], identity[key], 'Playback VM identity changed');
      assert.equal(caps.elf_crc, manifest.pcsx2_crc);
    }
    async function playerState() {
      await checkIdentity(); const status = await inspector.getStatus(); assert.ok(status.paused);
      const bytes = Buffer.from(await inspector.readMemoryStrict(playerMetadata.address, playerMetadata.size), 'hex');
      const values = {};
      for (const f of playerMetadata.fields) {
        assert.ok(f.offset >= 0 && f.offset + f.size <= bytes.length);
        values[f.name] = f.size === 8 ? (f.signed ? bytes.readBigInt64LE(f.offset) : bytes.readBigUInt64LE(f.offset)).toString()
          : f.signed ? bytes.readInt32LE(f.offset) : bytes.readUInt32LE(f.offset);
      }
      return { status, values, raw_hex: bytes.toString('hex'), epoch: identity.execution_epoch };
    }
    async function menu() {
      await inspector.pause(); await checkIdentity(); const result = {};
      for (const [name, object] of Object.entries(objects)) {
        const bytes = Buffer.from(await inspector.readMemoryStrict(object.address, object.size), 'hex');
        if (['s_Stage', 's_Pending', 's_Count', 's_Selected'].includes(name)) result[name] = bytes.readInt32LE();
        else if (name === 's_ID') result[name] = Array.from({ length: 64 }, (_, i) => bytes.subarray(i * 33, (i + 1) * 33).toString('ascii').split('\0')[0]);
        else result[name] = bytes.toString('ascii').split('\0')[0];
      }
      assert.equal(result.s_Boot, bootId); assert.ok(result.s_Count >= 0 && result.s_Count <= 64);
      report.last_menu = { stage: result.s_Stage, pending: result.s_Pending, count: result.s_Count,
        selected: result.s_Selected, selected_id: result.s_ID[result.s_Selected], detail_id: result.s_DetailID };
      return result;
    }
    async function waitMenu(predicate) {
      for (let i = 0; i < 120; i++) {
        const state = await menu(); if (predicate(state)) return state;
        await inspector.resume(); await delay(250);
      }
      assert.fail('SMS menu state did not reach expected stage before deadline');
    }
    async function press(button, allowBreakpoint = false) {
      await inspector.pause(); await checkIdentity();
      const action = { button, frames: fixture.input_frames }; report.actions.push(action);
      const pressed = await inspector.advanceFrames(fixture.input_frames, { input: { buttons: [button] } }); action.pressed = pressed;
      assert.ok(pressed.completed || allowBreakpoint && pressed.reason === 'breakpoint', 'Controller action interrupted');
      if (pressed.completed) {
        const released = await inspector.advanceFrames(fixture.input_frames, { input: { buttons: [] } }); action.released = released;
        assert.ok(released.completed || allowBreakpoint && released.reason === 'breakpoint', 'Controller release interrupted');
      }
      assert.equal((await inspector.getController(0)).pressed_mask, 0);
    }
    async function select(state, id) {
      const at = state.s_ID.slice(0, state.s_Count).indexOf(id); assert.ok(at >= 0, 'Known fixture ID not on current SMS page');
      for (let i = 0; i < (at - state.s_Selected + state.s_Count) % state.s_Count; i++) await press('down');
      const selected = await menu(); assert.equal(selected.s_ID[selected.s_Selected], id, 'SMS controller selection differs from known fixture');
      await press('cross');
    }
    let state = await waitMenu(s => !s.s_Pending && s.s_Stage === 0 && s.s_Count > 0);
    await select(state, fixture.library_id);
    state = await waitMenu(s => !s.s_Pending && s.s_Stage === 1 && s.s_Library === fixture.library_id && s.s_Count > 0);
    passed('SMS controller selects the exact known test library; DWARF menu objects and boot identity are read-only verified');
    const snapshot = path.resolve(path.dirname(manifestPath), manifest.source_snapshot), sourceName = 'src/SMS_GUICmdProc.c';
    const sourcePath = path.join(snapshot, sourceName), source = await fs.readFile(sourcePath);
    assert.equal(hash(source), manifest.sources.find(s => s.path === sourceName)?.sha256);
    const lines = source.toString('utf8').split(/\r?\n/).flatMap((line, i) => line.includes('SMS_JellyfinLog("player_enter");') ? [i + 1] : []);
    assert.equal(lines.length, 1);
    report.source = { path: sourceName, sha256: hash(source), line: lines[0] };
    for (let repetition = 0; repetition < fixture.repetitions; repetition++) {
      const run = { repetition, observation: 'pending', started_at: new Date().toISOString() }; report.runs.push(run);
      await select(state, fixture.item_id);
      state = await waitMenu(s => !s.s_Pending && s.s_Stage === 4 && s.s_DetailID === fixture.item_id);
      const group = await call('pcsx2_breakpoint_source', { elf, file: sourcePath, line: lines[0], expected_sha256: manifest.elf_sha256,
        path_mappings: [{ from: manifest.source_root_at_build, to: snapshot }] }); groups.add(group.group_id);
      const cursor = (await inspector.readEvents(0, 200)).next_cursor;
      await press('cross', true);
      const afterInput = await inspector.getStatus();
      if (!afterInput.paused || !group.addresses.some(pc => Number(pc) === Number(afterInput.pc))) {
        await inspector.resume();
        const hit = await inspector.waitEvent({ after: cursor, type: 'breakpoint', timeoutMs: 30000 });
        assert.ok(!hit.timed_out, 'SMS player-entry breakpoint was not reached');
      }
      await checkIdentity(); const stopped = await inspector.getStatus();
      assert.ok(stopped.paused && group.addresses.some(pc => Number(pc) === Number(stopped.pc)), 'Playback stopped outside verified player entry');
      state = await menu(); assert.equal(state.s_Stage, 3); assert.match(state.s_Session, /^[a-f0-9-]{36}$/);
      run.player_entry = { status: stopped, boot_id: state.s_Boot, playback_session: state.s_Session, breakpoint: group };
      run.state_at_entry = await playerState();
      const captureSif = async () => fixture.sif_snapshots ? call('pcsx2_sif_snapshot') : undefined;
      if (fixture.sif_snapshots) {
        run.sif_at_entry = await captureSif();
        assert.deepEqual(await captureSif(), run.sif_at_entry, 'Repeated paused SIF snapshots must preserve state/history');
      }
      // The service owner passes the exact published directory; never infer a source from an arbitrary filename.
      const directory = process.env.PCSX2_AUDIO_PUBLISHED_DIRECTORY; assert.ok(directory && path.isAbsolute(directory));
      const files = (await fs.readdir(directory)).filter(n => /^[a-f0-9]{64}\.mpg$/.test(n)); assert.equal(files.length, 1);
      const published = path.join(directory, files[0]), bytes = await fs.readFile(published);
      assert.equal(hash(bytes), fixture.reference_sha256, 'Actual Bridge-published clip differs from the pinned reference');
      run.published = { path: published, sha256: hash(bytes), size_bytes: bytes.length };
      const removed = await call('pcsx2_remove_source_breakpoints', { group_id: group.group_id }); assert.ok(removed.complete); groups.delete(group.group_id);
      if (fixture.trace_sif2) await traceSif2({ call, inspector, manifest, snapshot, elf, run, groups, checkIdentity, playerState, captureSif });
      const playerName = 'src/SMS_Player.c', playerPath = path.join(snapshot, playerName), playerSource = await fs.readFile(playerPath);
      assert.equal(hash(playerSource), manifest.sources.find(s => s.path === playerName)?.sha256);
      run.milestones = [];
      const playerLines = playerSource.toString('utf8').split(/\r?\n/);
      const functionStart = playerLines.findIndex(line => line.startsWith('static int _sms_play ('));
      const firstInput = playerLines.findIndex((line, index) => index > functionStart && line.trim() === 'uint32_t lBtn = GUI_ReadButtons ();');
      assert.ok(functionStart >= 0 && firstInput > functionStart);
      for (const needle of fixture.trace_sif2 ? [] : ['PlayerControl_Init ();', 'lSize = _fill_packet_queues ();', 's_Player.m_pIPUCtx -> StopSync ( 1 );', 'uint32_t lBtn = GUI_ReadButtons ();']) {
        const candidates = playerLines.flatMap((line, i) => i > functionStart && i <= firstInput && line.trim() === needle ? [i + 1] : []);
        assert.equal(candidates.length, 1, 'Playback milestone must resolve to one exact source line');
        const point = await call('pcsx2_breakpoint_source', { elf, file: playerPath, line: candidates[0], expected_sha256: manifest.elf_sha256,
          path_mappings: [{ from: manifest.source_root_at_build, to: snapshot }] }); groups.add(point.group_id);
        const milestone = { source: playerName, source_sha256: hash(playerSource), line: candidates[0], statement: needle, breakpoint: point };
        run.milestones.push(milestone);
        const after = (await inspector.readEvents(0, 200)).next_cursor; await inspector.resume();
        const event = await inspector.waitEvent({ after, type: 'breakpoint', timeoutMs: 10000 });
        milestone.reached = !event.timed_out;
        if (event.timed_out) assert.fail('SMS playback milestone not reached: ' + needle);
        await checkIdentity(); milestone.status = await inspector.getStatus();
        assert.ok(milestone.status.paused && point.addresses.some(pc => Number(pc) === Number(milestone.status.pc)));
        milestone.player_state = await playerState();
        assert.ok((await call('pcsx2_remove_source_breakpoints', { group_id: point.group_id })).complete); groups.delete(point.group_id);
      }
      const capture = await call('pcsx2_capture_start', { frames: fixture.capture_frames, width: 320, height: 240, audio: true, timeout_ms: 15000 });
      run.capture_started_at = new Date().toISOString(); await inspector.resume();
      const closed = await call('pcsx2_capture_status', { operation_id: capture.operation_id, wait_ms: 20000 }); run.capture = closed;
      assert.equal(closed.state, 'closed', 'Actual player capture did not close'); assert.equal(closed.artifact.verified, true);
      await inspector.pause(); await checkIdentity();
      run.measurement = await call('pcsx2_analyze_capture_audio', { capture_path: closed.path, capture_sha256: closed.artifact.sha256, output_directory: output });
      const collected = await call('pcsx2_diagnostics_collect', options); run.diagnostics = collected;
      const console = JSON.parse(await fs.readFile(collected.artifact.path));
      const entry = console.client_logs.filter(e => e.event === 'player_enter' && e.client_session === run.player_entry.playback_session);
      assert.equal(entry.length, 1, 'Exactly one actual player-enter console event required for this playback session');
      const log = await fs.readFile(journal); assert.ok(log.length < 2097152);
      const receipts = log.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(e => e.buildId === manifest.build_id && e.bootId === bootId
        && e.event === 'player_enter' && e.sessionId === run.player_entry.playback_session && e.sequence === entry[0].client_sequence);
      assert.equal(receipts.length, 1); run.player_enter_join = { console: entry[0], bridge: receipts[0], timing: 'separate_clocks_no_latency_claim' };
      const actualPcm = await fs.readFile(run.measurement.pcm.path); assert.equal(hash(actualPcm), run.measurement.pcm.sha256);
      assert.ok(actualPcm.length >= 2 * 48000 * 8, 'Capture has insufficient PCM after one-second warmup');
      run.analysis_interval = { decoded_start_frame: 48000, frame_count: Math.min(actualPcm.length / 8 - 48000, 48000), source_interval: 'whole_hash_pinned_constant_tone_reference_not_sample_aligned' };
      run.tone = toneEvidence(actualPcm.subarray(48000 * 8), report.reference.tone[0].frequency_hz);
      run.tone_present = run.tone.every((t, i) => t.tone_power_fraction >= .5 && t.rms_amplitude >= report.reference.tone[i].rms_amplitude / 100);
      run.observation = run.tone_present ? 'known_tone_measured' : 'known_tone_not_established';
      run.state_after_capture = await playerState();
      if (fixture.sif_snapshots) run.sif_after_capture = await captureSif();
      if (!run.tone_present) {
        await inspector.resume(); await delay(5000); await inspector.pause();
        run.state_after_additional_5s = await playerState();
        if (fixture.sif_snapshots) run.sif_after_additional_5s = await captureSif();
        const lateMenu = await menu();
        if (lateMenu.s_Stage === 3 && lateMenu.s_Session === run.player_entry.playback_session) {
          const late = await call('pcsx2_capture_start', { frames: fixture.capture_frames, width: 320, height: 240, audio: true, timeout_ms: 15000 });
          await inspector.resume();
          run.late_capture = await call('pcsx2_capture_status', { operation_id: late.operation_id, wait_ms: 20000 });
          assert.equal(run.late_capture.state, 'closed'); assert.equal(run.late_capture.artifact.verified, true);
          await inspector.pause(); await checkIdentity();
          run.late_measurement = await call('pcsx2_analyze_capture_audio', { capture_path: run.late_capture.path,
            capture_sha256: run.late_capture.artifact.sha256, output_directory: output });
          run.state_after_late_capture = await playerState();
          if (fixture.sif_snapshots) run.sif_after_late_capture = await captureSif();
        }
      }
      assert.ok(run.tone_present, 'Known clip tone not established in actual SMS capture; inspect retained evidence');
      passed('actual SMS capture contains the pinned clip tone in both channels; listening and A/V sync remain unmeasured');
      await inspector.resume();
      state = await waitMenu(s => !s.s_Pending && s.s_Stage === 1 && s.s_Library === fixture.library_id && !s.s_Session);
      run.catalog_return = { boot_id: state.s_Boot, stage: state.s_Stage, session_closed: true };
    }
    assert.equal(hash(await fs.readFile(elf)), manifest.elf_sha256); assert.equal(hash(await fs.readFile(fixture.reference_path)), fixture.reference_sha256);
    report.passed = true;
    return { artifact_path: path.join(output, 'playback-audio.json'), passed: true, repetitions: report.runs.length };
  } catch (error) {
    report.failure = error instanceof assert.AssertionError ? error.message : 'Playback audio operation failed; inspect private evidence';
    if (fixture.sif_snapshots) {
      try { await inspector.pause(); report.failure_sif = await call('pcsx2_sif_snapshot'); }
      catch { report.failure_sif_unavailable = true; }
    }
    try {
      await inspector.pause(); report.failure_threads = await inspector.getThreads(); report.failure_context = await inspector.captureContext({ width: 320, height: 240 });
      if (report.failure_context.screenshot.ok) {
        await fs.writeFile(path.join(output, 'playback-failure.png'), Buffer.from(report.failure_context.screenshot.data, 'base64'), { flag: 'wx' });
        report.failure_context.screenshot = { ...report.failure_context.screenshot, data: undefined, saved_as: 'playback-failure.png' };
      }
    } catch { report.context_unavailable = true; }
    throw error;
  } finally {
    for (const group of groups) await inspector.removeSourceBreakpoints(group).catch(() => { report.breakpoint_cleanup_incomplete = true; });
    await fs.writeFile(path.join(output, 'playback-audio.json'), JSON.stringify(report, null, 2)+'\n', { flag: 'wx', mode: 0o600 });
  }
}
