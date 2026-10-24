import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DebugServerClient } from './debug-server-client.js';
import { watchId } from './exceptions.js';
import { mediaOptions, verifyMedia, type MediaOptions } from './media.js';
import { analyzeCaptureAudio, audioMeasurementOptions } from './audio-measurement.js';

export async function stopMediaCapture(client: DebugServerClient, id: string) {
  const deadline = performance.now() + 15000;
  let result = await client.mediaStatus(id, true);
  while (result.active && performance.now() < deadline) { await delay(50); result = await client.mediaStatus(id); }
  if (result.active) throw new Error(`Media cleanup could not be confirmed; query operation ${id}`);
  return result;
}
export async function startMediaCapture(client: DebugServerClient, input: MediaOptions = {}, signal?: AbortSignal) {
  const options = mediaOptions.parse(input);
  return client.withExclusiveSession(async () => {
    signal?.throwIfAborted();
    const caps = await client.getCapabilities();
    if (!caps.features.includes('media_capture') || caps.process_id === undefined || caps.execution_epoch === undefined)
      throw new Error('Rebuild PCSX2: media_capture and VM identity required');
    const id = randomUUID().replaceAll('-', '');
    try {
      const result = await client.startMediaCapture(id, { ...caps, process_id: caps.process_id, execution_epoch: caps.execution_epoch }, options);
      signal?.throwIfAborted(); return result;
    } catch (error) {
      if (error instanceof Error && 'native_rejected' in error) throw error;
      let cleanup: unknown;
      try { cleanup = await stopMediaCapture(client, id); }
      catch (failure) { cleanup = { error: String(failure), pending_operation_id: id }; }
      throw Object.assign(new Error(`Media capture start failed: ${String(error)}`), { cleanup });
    }
  });
}
export async function readMediaCapture(client: DebugServerClient, id: string, waitMs = 0, signal?: AbortSignal) {
  watchId.parse(id); z.number().int().min(0).max(30000).parse(waitMs);
  const deadline = performance.now() + waitMs;
  for (;;) {
    signal?.throwIfAborted(); const result = await client.mediaStatus(id);
    if (result.state === 'closed') {
      const artifact = await verifyMedia(result, signal);
      if (JSON.stringify(await client.mediaStatus(id)) !== JSON.stringify(result)) throw new Error('Media operation changed during verification');
      return { ...result, timed_out: false, artifact };
    }
    if (!result.active || performance.now() >= deadline) return { ...result, timed_out: result.active, artifact: { verified: false } };
    await delay(50, undefined, { signal });
  }
}
export function registerMediaTools(server: McpServer, getClient: () => DebugServerClient | null) {
  server.tool('pcsx2_analyze_capture_audio', 'Measure one SHA256-pinned local MP4 AAC stereo 48000 Hz track offline. Preserves MP4, decoded float PCM, per-channel RMS/peak/DC, near-full-scale counts and bounded silence windows. Requires ffmpeg/ffprobe (PCSX2_FFMPEG/PCSX2_FFPROBE overrides). At most ten decoded seconds, 144 MiB input and one analysis per MCP. Does not connect to a VM or judge audible quality, clipping causes, dropouts, A/V sync or physical PS2 behavior; acceptance remains not_evaluated.',
    audioMeasurementOptions.shape, async (input, extra) => {
      try { return { content: [{ type: 'text' as const, text: JSON.stringify(await analyzeCaptureAudio(input, extra.signal), null, 2) }] }; }
      catch (error) { return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error instanceof Error ? error.message : 'Audio measurement failed',
        ...(error instanceof Error && 'artifact_directory' in error ? { artifact_directory: error.artifact_directory } : {}) }) }], isError: true }; }
    });
  async function run(operation: (client: DebugServerClient) => Promise<unknown>) {
    try {
      const client = getClient(); if (!client?.isConnected()) throw new Error('Connect to DebugServer first');
      return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(client), null, 2) }] };
    } catch (error) { return { content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error),
      ...(error instanceof Error && 'cleanup' in error ? { cleanup: error.cleanup } : {}) }) }], isError: true }; }
  }
  server.tool('pcsx2_capture_start', 'Start an owned MP4 recording with bounded resolution, video frames, wall lifetime and encoded packet payload. Optional stereo audio; codecs use native capture settings. Does not resume or overwrite files, and refuses an existing GUI recording. Payload ceiling excludes container overhead.',
    mediaOptions.shape, (input, extra) => run(client => startMediaCapture(client, input, extra.signal)));
  server.tool('pcsx2_capture_status', 'Read/wait after reconnect. A closed MP4 is checked using local ffprobe for actual tracks, resolution, decoded frame count, duration and size, then hashed. Requires ffprobe on PATH or PCSX2_FFPROBE. Does not assess audible sound or A/V sync. Wait timeout/cancellation leaves native recording active until its own limit.',
    { operation_id: watchId, wait_ms: z.number().int().min(0).max(30000).default(0) },
    ({ operation_id, wait_ms }, extra) => run(client => readMediaCapture(client, operation_id, wait_ms, extra.signal)));
  server.tool('pcsx2_capture_stop', 'Stop only this recording ID and wait for encoder finalization. Preserves GUI captures and completed files; does not pause or resume. Use capture_status afterward to verify the file.',
    { operation_id: watchId }, ({ operation_id }) => run(client => stopMediaCapture(client, operation_id)));
}
