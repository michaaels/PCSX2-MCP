import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DebugServerClient } from './debug-server-client.js';
import { watchId } from './exceptions.js';
import { hashLocalFile, inspectMovie, movieOptions, replayOptions, type MovieOptions, type ReplayOptions } from './input-movie.js';
import { inspectSourceElf } from './source-debug.js';

const localElf = (filename: string) => filename.startsWith('host:') ? filename.slice(5) : filename;

export async function startInputMovie(client: DebugServerClient, input: MovieOptions | ReplayOptions,
  mode: 'record' | 'replay', signal?: AbortSignal) {
  const options = mode === 'record' ? movieOptions.parse(input) : replayOptions.parse(input);
  return client.withExclusiveSession(async () => {
    signal?.throwIfAborted();
    const caps = await client.getCapabilities();
    if (!caps.features.includes('input_movies') || caps.process_id === undefined || caps.execution_epoch === undefined)
      throw new Error('Rebuild PCSX2: input_movies and native VM identity required');
    const elf = await inspectSourceElf(localElf(caps.elf));
    if (Number(elf.elf_crc) !== Number(caps.elf_crc)) throw new Error('Local ELF CRC differs from the running ELF');
    signal?.throwIfAborted();
    let source: Awaited<ReturnType<typeof inspectMovie>> | undefined;
    if ('path' in options) {
      source = await inspectMovie(options.path, signal);
      if (source.from_savestate) throw new Error('Savestate movies are not supported yet');
      if (source.sha256 !== options.movie_sha256 || elf.sha256 !== options.elf_sha256)
        throw new Error('Replay movie/ELF SHA256 does not match the supplied identity');
    }
    const id = randomUUID().replaceAll('-', '');
    try {
      const result = await client.startInputMovie(id, { ...caps, process_id: caps.process_id, execution_epoch: caps.execution_epoch },
        { ...options, mode, elf_sha256: elf.sha256 });
      if (source) {
        const copied = await inspectMovie(result.path, signal);
        if (copied.sha256 !== source.sha256 || copied.frames !== result.max_frames)
          throw new Error('Native replay copy differs from the validated source');
      }
      if ((await hashLocalFile(localElf(caps.elf), 256 * 1024 * 1024, signal)).sha256 !== elf.sha256)
        throw new Error('ELF file changed during input movie startup');
      signal?.throwIfAborted(); return result;
    } catch (error) {
      if (error instanceof Error && 'native_rejected' in error) throw error;
      let cleanup: unknown;
      try { cleanup = await client.inputMovieStatus(id, true); }
      catch (failure) { cleanup = { error: String(failure), pending_operation_id: id }; }
      throw Object.assign(new Error(`Input movie start failed: ${String(error)}`), { cleanup });
    }
  });
}

export async function readInputMovie(client: DebugServerClient, id: string, waitMs = 0, signal?: AbortSignal) {
  watchId.parse(id); z.number().int().min(0).max(30000).parse(waitMs);
  const deadline = performance.now() + waitMs;
  for (;;) {
    signal?.throwIfAborted(); const result = await client.inputMovieStatus(id);
    if (result.state === 'closed' && result.frames > 0 && result.reason !== 'io_error') {
      const artifact = await inspectMovie(result.path, signal);
      if (artifact.from_savestate || artifact.frames !== (result.mode === 'record' ? result.frames : result.max_frames))
        throw new Error('Closed movie frame/header count differs from native status');
      const source = result.mode === 'replay' ? await inspectMovie(result.source, signal) : null;
      if (source && (source.sha256 !== artifact.sha256 || source.sha256 !== result.input_sha256))
        throw new Error('Replay source differs from the original identity or closed working copy');
      const elf = await hashLocalFile(localElf(result.elf), 256 * 1024 * 1024, signal);
      if (elf.sha256 !== result.elf_sha256) throw new Error('ELF file identity changed since movie startup');
      const after = await client.inputMovieStatus(id);
      // Pausing/resuming after completion does not change the immutable movie.
      if (JSON.stringify({ ...after, paused: false }) !== JSON.stringify({ ...result, paused: false }))
        throw new Error('Input movie changed during verification');
      return { ...result, timed_out: false, completed: result.reason === 'eof' || result.reason === 'frame_limit',
        artifact, source_preserved: source ? true : null, elf_file_sha256: elf.sha256 };
    }
    if (!result.active || performance.now() >= deadline)
      return { ...result, timed_out: result.active, completed: false, artifact: { verified: false } };
    await delay(50, undefined, { signal });
  }
}

export function registerInputMovieTools(server: McpServer, getClient: () => DebugServerClient | null) {
  async function run(operation: () => Promise<unknown>) {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(), null, 2) }] }; }
    catch (error) { return { content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error),
      ...(error instanceof Error && 'cleanup' in error ? { cleanup: error.cleanup } : {}) }) }], isError: true }; }
  }
  function client() { const value = getClient(); if (!value?.isConnected()) throw new Error('Connect to DebugServer first'); return value; }
  server.tool('pcsx2_input_record', 'Start an owned power-on p2m2 v1 recording from a paused ELF. Resets the VM and invalidates prior inspection state. Leaves it paused: explicitly resume. Requires native recording tools and two DualShock2 ports; frame/time bounds always apply.',
    movieOptions.shape, (input, extra) => run(() => startInputMovie(client(), input, 'record', extra.signal)));
  server.tool('pcsx2_input_replay', 'Replay a complete power-on p2m2 v1 (1-600 input frames) in a private copy. Requires supplied movie and ELF SHA256, a paused matching ELF and recording tools. Resets and leaves paused; explicitly resume. Stops at EOF without rerecording. No network/timing determinism guarantee.',
    replayOptions.shape, (input, extra) => run(() => startInputMovie(client(), input, 'replay', extra.signal)));
  server.tool('pcsx2_input_movie_status', 'Read/wait for an owned movie across reconnect. Verifies closed structure, actual frames and SHA256; replay also compares source and copy. A wait timeout/cancellation leaves recording active until its native limit. Historical completion does not attest current VM state.',
    { operation_id: watchId, wait_ms: z.number().int().min(0).max(30000).default(0) },
    ({ operation_id, wait_ms }, extra) => run(() => readInputMovie(client(), operation_id, wait_ms, extra.signal)));
  server.tool('pcsx2_input_movie_stop', 'Synchronously close only this movie ID and pause, restoring replay pad input. Does not stop a GUI/foreign recording. Status verifies any nonempty closed file afterward.',
    { operation_id: watchId }, ({ operation_id }) => run(() => client().inputMovieStatus(operation_id, true)));
  server.tool('pcsx2_input_movie_inspect', 'Inspect a bounded local p2m2 v1 header, complete two-port frame records and SHA256 without a connection. Does not prove the original ELF or deterministic execution. Savestate companions are not verified.',
    { path: z.string().min(1).max(4096) }, ({ path }, extra) => run(() => inspectMovie(path, extra.signal)));
}
