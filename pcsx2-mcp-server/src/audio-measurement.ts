import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setImmediate as yieldImmediate } from 'node:timers/promises';

const RATE = 48000, CHANNELS = 2, MAX_FRAMES = RATE * 10, MAX_FILE = 144 * 1024 * 1024;
const absolutePath = z.string().min(1).max(4096).refine(path.isAbsolute, 'Absolute local path required');
export const audioMeasurementPolicy = z.object({
  window_ms: z.number().int().min(10).max(1000).default(20),
  silence_rms_dbfs: z.number().finite().min(-120).max(-20).default(-60),
  near_full_scale_amplitude: z.number().finite().min(0.5).max(1).default(0.999),
}).strict();
export const audioMeasurementOptions = z.object({
  capture_path: absolutePath.refine(p => path.extname(p).toLowerCase() === '.mp4', 'Local MP4 required'),
  capture_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  output_directory: absolutePath,
  policy: audioMeasurementPolicy.default({}),
}).strict();
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const dbfs = (amplitude: number) => amplitude === 0 ? null : 20 * Math.log10(amplitude);

/** No shell; failure messages intentionally exclude untrusted decoder stderr. */
export function runAudioProcess(executable: string, args: string[], maxBytes: number, signal?: AbortSignal, timeoutMs = 15000) {
  signal?.throwIfAborted();
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let bytes = 0, errors = 0, failure: Error | undefined;
    const fail = (error: Error) => { failure ??= error; child.kill(); };
    const abort = () => fail(new Error('Audio measurement cancelled'));
    const timer = setTimeout(() => fail(new Error('Audio process exceeded runtime budget')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (data: Buffer) => {
      if (failure) return; bytes += data.length;
      if (bytes > maxBytes) fail(new Error('Audio process exceeded output budget'));
      else chunks.push(data);
    });
    child.stderr.on('data', (data: Buffer) => { errors += data.length; if (errors > 131072) fail(new Error('Audio process exceeded stderr budget')); });
    child.on('error', () => { failure ??= new Error('Audio executable unavailable or failed to start'); });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Audio process failed (exit ${code})`));
      else resolve(Buffer.concat(chunks, bytes));
    });
  });
}

/** Float PCM is not clamped: decoder overshoot is preserved and reported. */
export async function measureAudioPcm(pcm: Buffer, input: z.input<typeof audioMeasurementPolicy> = {}, signal?: AbortSignal) {
  const policy = audioMeasurementPolicy.parse(input), frames = pcm.length / (4 * CHANNELS);
  if (!Number.isInteger(frames) || frames < 1 || frames > MAX_FRAMES) throw new Error('PCM must contain 1 to 480000 complete stereo float32 frames');
  const windowFrames = policy.window_ms * RATE / 1000, windows = [];
  const totals = Array.from({ length: CHANNELS }, () => ({ sum: 0, squares: 0, peak: 0, near: 0, zero: 0, silent: 0, run: 0, longest: 0 }));
  for (let start = 0; start < frames; start += windowFrames) {
    await yieldImmediate(undefined, { signal });
    const count = Math.min(windowFrames, frames - start);
    const channels = [];
    for (let channel = 0; channel < CHANNELS; channel++) {
      let squares = 0, peak = 0, sum = 0, near = 0, zero = 0;
      for (let frame = start; frame < start + count; frame++) {
        const value = pcm.readFloatLE((frame * CHANNELS + channel) * 4);
        if (!Number.isFinite(value)) throw new Error('PCM contains nonfinite amplitude');
        sum += value; squares += value * value; peak = Math.max(peak, Math.abs(value));
        if (Math.abs(value) >= policy.near_full_scale_amplitude) near++;
        if (value === 0) zero++;
      }
      const rms = Math.sqrt(squares / count), silent = rms <= 10 ** (policy.silence_rms_dbfs / 20), total = totals[channel];
      total.sum += sum; total.squares += squares; total.peak = Math.max(total.peak, peak); total.near += near; total.zero += zero;
      total.run = silent ? total.run + count : 0; total.longest = Math.max(total.longest, total.run); if (silent) total.silent += count;
      channels.push({ channel, rms_dbfs: dbfs(rms), peak_amplitude: peak, dc_offset: sum / count,
        near_full_scale_samples: near, rms_at_or_below_silence_threshold: silent });
    }
    windows.push({ start_frame: start, frame_count: count, channels });
  }
  signal?.throwIfAborted();
  return { sample_rate: RATE, channels: CHANNELS, frame_count: frames, decoded_duration_seconds: frames / RATE,
    policy, channel_metrics: totals.map((t, channel) => ({ channel, rms_amplitude: Math.sqrt(t.squares / frames),
      rms_dbfs: dbfs(Math.sqrt(t.squares / frames)), peak_amplitude: t.peak, peak_dbfs: dbfs(t.peak), dc_offset: t.sum / frames,
      exact_zero_samples: t.zero, near_full_scale_samples: t.near, near_full_scale_fraction: t.near / frames,
      silent_window_frames: t.silent, silent_window_fraction: t.silent / frames, longest_silent_window_run_ms: t.longest / RATE * 1000 })), windows };
}

export function validateAudioProbe(value: unknown) {
  const stream = z.object({ index: z.number().int().nonnegative(), codec_type: z.string(), codec_name: z.string(),
    sample_rate: z.string().optional(), channels: z.number().int().optional(), start_time: z.string().optional(), duration: z.string().optional() });
  const info = z.object({ streams: z.array(stream).min(1).max(2), format: z.object({ format_name: z.string() }) }).parse(value);
  const audio = info.streams.filter(s => s.codec_type === 'audio');
  if (!info.format.format_name.split(',').includes('mp4') || audio.length !== 1 || audio[0].codec_name !== 'aac' ||
      audio[0].sample_rate !== '48000' || audio[0].channels !== 2 || info.streams.some(s => !['audio', 'video'].includes(s.codec_type)))
    throw new Error('Expected exactly one AAC stereo 48000 Hz track in local MP4 (optional single video track)');
  return info;
}

async function readPinnedFile(filename: string, expected: string, copyTo: string | undefined, signal: AbortSignal) {
  const original = await fs.stat(filename);
  if (!original.isFile() || original.size < 1 || original.size > MAX_FILE) throw new Error('Audio input must be a regular file of 1 byte to 144 MiB');
  const file = await fs.open(filename, 'r');
  let target: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const before = await file.stat(), hash = createHash('sha256'); let count = 0;
    if (copyTo) target = await fs.open(copyTo, 'wx', 0o600);
    for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
      signal.throwIfAborted(); count += chunk.length;
      if (count > MAX_FILE) throw new Error('Audio input grew beyond byte budget');
      hash.update(chunk); if (target) await target.writeFile(chunk);
    }
    const after = await file.stat(), current = await fs.stat(filename);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const)
      if (before[key] !== original[key] || before[key] !== after[key] || before[key] !== current[key]) throw new Error('Audio input changed during read');
    if (count !== before.size || hash.digest('hex') !== expected) throw new Error('Audio input SHA256 mismatch');
    signal.throwIfAborted(); return { sha256: expected, size_bytes: count };
  } finally { await target?.close(); await file.close(); }
}

let active = false;
export async function analyzeCaptureAudio(input: z.input<typeof audioMeasurementOptions>, signal?: AbortSignal) {
  const o = audioMeasurementOptions.parse(input);
  signal?.throwIfAborted();
  if (active) throw new Error('Another audio measurement is active in this MCP process');
  active = true;
  const bounded = AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]);
  let directory: string | undefined;
  try {
    await fs.mkdir(o.output_directory, { recursive: true });
    directory = await fs.mkdtemp(path.join(o.output_directory, 'pcsx2-audio-'));
    const snapshot = path.join(directory, 'capture.mp4');
    const source = await readPinnedFile(o.capture_path, o.capture_sha256, snapshot, bounded);
    const probeExecutable = process.env.PCSX2_FFPROBE || 'ffprobe', decoderExecutable = process.env.PCSX2_FFMPEG || 'ffmpeg';
    const version = async (exe: string) => (await runAudioProcess(exe, ['-version'], 65536, bounded)).toString('utf8').split(/\r?\n/)[0];
    const versions = { ffprobe: await version(probeExecutable), ffmpeg: await version(decoderExecutable) };
    const localInput = ['-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe',
      '-probesize', '8388608', '-analyzeduration', '10000000', '-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0'];
    const probe = validateAudioProbe(JSON.parse((await runAudioProcess(probeExecutable, [...localInput,
      '-show_entries', 'format=format_name:stream=index,codec_type,codec_name,sample_rate,channels,start_time,duration',
      '-of', 'json', snapshot], 1048576, bounded)).toString('utf8')));
    const pcm = await runAudioProcess(decoderExecutable, ['-nostdin', '-xerror', ...localInput, '-threads', '1', '-i', snapshot,
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-threads', '1', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], MAX_FRAMES * CHANNELS * 4, bounded);
    const metrics = await measureAudioPcm(pcm, o.policy, bounded);
    await readPinnedFile(snapshot, o.capture_sha256, undefined, bounded);
    await readPinnedFile(o.capture_path, o.capture_sha256, undefined, bounded);
    const pcmPath = path.join(directory, 'audio.f32le'); await fs.writeFile(pcmPath, pcm, { flag: 'wx', mode: 0o600 });
    const report = { format_version: 1, kind: 'pcsx2_audio_measurement', created_at: new Date().toISOString(),
      source: { ...source, path: o.capture_path, snapshot_path: snapshot, vm_identity: 'not_observed_offline' },
      decoder_versions: versions, probe, metrics, policy_sha256: sha(JSON.stringify(metrics.policy)),
      pcm: { path: pcmPath, sha256: sha(pcm), size_bytes: pcm.length, encoding: 'interleaved_stereo_float32_little_endian' },
      algorithm: { id: 'decoded_pcm_window_metrics_v1', full_scale_amplitude: 1, zero_dbfs: 'null_represents_negative_infinity',
        gain_normalization_resampling: 'none', silence: 'window_rms_less_than_or_equal_to_configured_threshold',
        near_full_scale: 'absolute_sample_greater_than_or_equal_to_threshold_not_proof_of_clipping',
        window_time_origin: 'first_decoded_sample_not_guest_or_wall_clock', partial_last_window: 'included_with_actual_frame_count' },
      acceptance: 'not_evaluated', audio_audibility: 'not_measured', av_sync: 'not_measured',
      dropout_cause: 'not_determined', physical_ps2_validation: 'not_performed' };
    bounded.throwIfAborted();
    const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n'), reportPath = path.join(directory, 'measurement.json');
    await fs.writeFile(reportPath, bytes, { flag: 'wx', mode: 0o600 });
    return { ...report, report_artifact: { path: reportPath, sha256: sha(bytes), size_bytes: bytes.length } };
  } catch (error) {
    if (directory) {
      await fs.writeFile(path.join(directory, 'failure.json'), JSON.stringify({ kind: 'pcsx2_audio_measurement_failure',
        complete: false, acceptance: 'not_evaluated', error: error instanceof Error ? error.message : 'Audio measurement failed' }, null, 2), { flag: 'wx', mode: 0o600 }).catch(() => {});
      throw Object.assign(new Error(error instanceof Error ? error.message : 'Audio measurement failed'), { artifact_directory: directory });
    }
    throw error;
  } finally { active = false; }
}
