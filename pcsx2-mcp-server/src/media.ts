import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { watchId } from './exceptions.js';
import { address } from './symbols.js';

const count = z.number().int().nonnegative().safe();
export const mediaOptions = z.object({
  frames: z.number().int().min(1).max(300).default(120),
  timeout_ms: z.number().int().min(100).max(30000).default(15000),
  max_payload_bytes: z.number().int().min(1024).max(128 * 1024 * 1024).default(64 * 1024 * 1024),
  width: z.number().int().min(64).max(1280).multipleOf(8).default(640),
  height: z.number().int().min(64).max(1024).multipleOf(8).default(480),
  audio: z.boolean().default(true),
});
export type MediaOptions = z.input<typeof mediaOptions>;
const response = z.object({
  ok: z.literal(true), operation_id: watchId,
  state: z.enum(['queued', 'recording', 'stopping', 'closed', 'failed', 'invalidated']),
  active: z.boolean(), reason: z.string(), session: count, execution_epoch: count,
  elf: z.string(), elf_crc: address, path: z.string().min(1), video: z.literal(true), audio: z.boolean(),
  width: mediaOptions.shape.width.removeDefault(), height: mediaOptions.shape.height.removeDefault(),
  video_frames: count, max_frames: mediaOptions.shape.frames.removeDefault(), payload_bytes: count,
  max_payload_bytes: mediaOptions.shape.max_payload_bytes.removeDefault(), container: z.literal('mp4'),
});
export function parseMedia(value: unknown, id: string) {
  const result = response.parse(value);
  if (result.operation_id !== id || result.active !== ['queued', 'recording', 'stopping'].includes(result.state) ||
      result.payload_bytes > result.max_payload_bytes || result.video_frames > result.max_frames ||
      !path.isAbsolute(result.path) || !result.path.replaceAll('\\', '/').endsWith(`/${id}.mp4`))
    throw new Error('Inconsistent media capture ownership/state/budget');
  return result;
}
export type MediaState = ReturnType<typeof parseMedia>;

// No shell. Bound runtime/output and restrict demuxing to a local MP4 file.
export function probeMedia(filename: string, signal?: AbortSignal, executable = process.env.PCSX2_FFPROBE || 'ffprobe') {
  return new Promise<unknown>((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(executable, ['-v', 'error', '-threads', '1', '-max_alloc', '67108864', '-protocol_whitelist', 'file',
      '-probesize', '8388608', '-analyzeduration', '10000000', '-f', 'mov', '-count_frames', '-show_streams', '-show_format', '-of', 'json', filename],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errorOutput = '', failure: Error | undefined;
    function fail(error: Error) { if (!failure) failure = error; child.kill(); }
    const abort = () => fail(new Error('Media verification cancelled'));
    const timer = setTimeout(() => fail(new Error('ffprobe exceeded 15 seconds')), 15000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', data => { if (failure) return; output += data; if (Buffer.byteLength(output) > 1024 * 1024) fail(new Error('ffprobe output exceeded 1 MiB')); });
    child.stderr.on('data', data => { if (failure) return; errorOutput += data; if (Buffer.byteLength(errorOutput) > 131072) fail(new Error('ffprobe error output exceeded 128 KiB')); });
    child.on('error', error => { failure = new Error(`ffprobe unavailable or failed: ${error.message}`); });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error(`ffprobe failed (${code}): ${errorOutput.slice(0, 2048)}`)); return; }
      try { resolve(JSON.parse(output)); } catch { reject(new Error('ffprobe returned invalid JSON')); }
    });
  });
}

const numericString = z.string().regex(/^\d+$/).transform(Number).pipe(count);
const stream = z.object({ codec_type: z.enum(['video', 'audio']), codec_name: z.string().min(1),
  width: count.optional(), height: count.optional(), nb_read_frames: numericString.optional(),
  sample_rate: numericString.optional(), channels: count.optional(),
  start_time: z.string().optional(), duration: z.string().optional(),
});
export function validateProbe(value: unknown, expected: MediaState) {
  const probe = z.object({ streams: z.array(stream).min(1).max(2),
    format: z.object({ format_name: z.string(), duration: z.string(), size: numericString }) }).parse(value);
  const videos = probe.streams.filter(value => value.codec_type === 'video');
  const audios = probe.streams.filter(value => value.codec_type === 'audio');
  const duration = Number(probe.format.duration);
  if (videos.length !== 1 || videos[0].width !== expected.width || videos[0].height !== expected.height ||
      videos[0].nb_read_frames !== expected.video_frames || expected.video_frames === 0 ||
      audios.length !== (expected.audio ? 1 : 0) || !Number.isFinite(duration) || duration <= 0 ||
      !probe.format.format_name.split(',').includes('mp4')) throw new Error('MP4 tracks, dimensions, frame count or duration do not match capture');
  if (expected.audio && (!audios[0].nb_read_frames || audios[0].sample_rate !== 48000 || audios[0].channels !== 2))
    throw new Error('Expected captured stereo 48000 Hz audio packets');
  return { streams: probe.streams, duration_seconds: duration, bytes: probe.format.size };
}

export async function verifyMedia(expected: MediaState, signal?: AbortSignal,
  probe: (filename: string, signal?: AbortSignal) => Promise<unknown> = probeMedia) {
  if (expected.state !== 'closed' || expected.active) throw new Error('Media file is not confirmed closed');
  const deadline = performance.now() + 30000;
  const before = await fs.stat(expected.path);
  if (!before.isFile() || before.size === 0 || before.size > expected.max_payload_bytes + 16 * 1024 * 1024)
    throw new Error('Media file size is invalid or exceeds verification budget');
  const info = validateProbe(await probe(expected.path, signal), expected);
  if (info.bytes !== before.size) throw new Error('ffprobe file size differs from the capture file');
  const hash = createHash('sha256');
  const file = await fs.open(expected.path, 'r');
  try {
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted(); if (performance.now() >= deadline) throw new Error('Media verification exceeded 30 seconds'); hash.update(chunk);
    }
  } finally { await file.close(); }
  const after = await fs.stat(expected.path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('Capture file changed during verification');
  return { verified: true as const, ...info, sha256: hash.digest('hex'), audio_audibility: 'not_measured', av_sync: 'not_measured' };
}
