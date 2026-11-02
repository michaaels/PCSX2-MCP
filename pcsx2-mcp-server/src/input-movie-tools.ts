import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { inputStateOptions, inspectInputState } from './input-state.js';
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
    let companion: Awaited<ReturnType<typeof inspectInputState>> | undefined;
    if ('path' in options) {
      source = await inspectMovie(options.path, signal);
      if (source.from_savestate) {
        if (!options.state_path || !options.state_sha256) throw new Error('Savestate replay requires state_path and state_sha256');
        companion = await inspectInputState({ path: options.state_path, expected_sha256: options.state_sha256 }, signal);
      } else if (options.state_path || options.state_sha256) throw new Error('Power-on movies cannot use a savestate companion');
      if (source.sha256 !== options.movie_sha256 || elf.sha256 !== options.elf_sha256)
        throw new Error('Replay movie/ELF SHA256 does not match the supplied identity');
    }
    const start = source ? source.from_savestate ? 'savestate' : 'power_on' : 'start' in options ? options.start : 'power_on';
    if (start === 'savestate' && !caps.features.includes('input_movie_states'))
      throw new Error('Rebuild PCSX2: input_movie_states required for savestate movies');
    const id = randomUUID().replaceAll('-', '');
    try {
      let result = await client.startInputMovie(id, { ...caps, process_id: caps.process_id, execution_epoch: caps.execution_epoch },
        { ...options, start, mode, elf_sha256: elf.sha256 });
      if (start === 'savestate' && mode === 'record') {
        const deadline = performance.now() + options.timeout_ms;
        while (result.state === 'preparing') {
          if (performance.now() >= deadline) throw new Error('Companion save deadline exceeded');
          await delay(25, undefined, { signal }); result = await client.inputMovieStatus(id);
        }
        if (result.state !== 'prepared' || result.state_outcome !== 'saved') throw new Error('Native companion save did not complete');
        companion = await inspectInputState({ path: result.state_path }, signal);
        result = await client.acceptInputMovieState(id, companion.sha256);
      }
      if (source) {
        const copied = await inspectMovie(result.path, signal);
        if (copied.sha256 !== source.sha256 || copied.frames !== result.max_frames)
          throw new Error('Native replay copy differs from the validated source');
      }
      if (companion) {
        if (result.state_sha256 !== companion.sha256) throw new Error('Native companion identity differs from preflight');
        await inspectInputState({ path: result.state_path, expected_sha256: companion.sha256 }, signal);
      }
      if ((await hashLocalFile(localElf(caps.elf), 256 * 1024 * 1024, signal)).sha256 !== elf.sha256)
        throw new Error('ELF file changed during input movie startup');
      signal?.throwIfAborted(); return { ...result, ...(companion ? { companion,
        elf_association: 'caller_supplied_not_embedded' as const, determinism: 'not_established' as const } : {}) };
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
      if (artifact.from_savestate !== (result.start === 'savestate') || artifact.frames !== (result.mode === 'record' ? result.frames : result.max_frames))
        throw new Error('Closed movie frame/header count differs from native status');
      const source = result.mode === 'replay' ? await inspectMovie(result.source, signal) : null;
      if (source && (source.sha256 !== artifact.sha256 || source.sha256 !== result.input_sha256))
        throw new Error('Replay source differs from the original identity or closed working copy');
      const companion = result.start === 'savestate'
        ? await inspectInputState({ path: result.state_path, expected_sha256: result.state_sha256 }, signal) : null;
      if (companion && result.mode === 'replay')
        await inspectInputState({ path: result.state_source, expected_sha256: companion.sha256 }, signal);
      const elf = await hashLocalFile(localElf(result.elf), 256 * 1024 * 1024, signal);
      if (elf.sha256 !== result.elf_sha256) throw new Error('ELF file identity changed since movie startup');
      const after = await client.inputMovieStatus(id);
      // Pausing/resuming after completion does not change the immutable movie.
      if (JSON.stringify({ ...after, paused: false }) !== JSON.stringify({ ...result, paused: false }))
        throw new Error('Input movie changed during verification');
      return { ...result, timed_out: false, completed: result.reason === 'eof' || result.reason === 'frame_limit',
        artifact, source_preserved: source ? true : null, elf_file_sha256: elf.sha256,
        ...(companion ? { companion, state_source_preserved: source ? true : null,
          elf_association: 'caller_supplied_not_embedded' as const, determinism: 'not_established' as const } : {}) };
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
  server.tool('pcsx2_input_record', 'Start an owned p2m2 v1 recording from a paused ELF. start=power_on resets the VM; start=savestate waits for native async save finalization, verifies the companion archive and pins its SHA before accepting input. Leaves paused: explicitly resume. Requires recording tools and two DualShock2 ports; frame/time bounds include save preparation.',
    movieOptions.shape, (input, extra) => run(() => startInputMovie(client(), input, 'record', extra.signal)));
  server.tool('pcsx2_input_replay', 'Replay a complete p2m2 v1 (1-600 input frames) in private read-only copies. Requires supplied movie and ELF SHA256 and a paused matching ELF. A savestate movie also requires state_path/state_sha256: archive preflight and native copy hashes precede actual load. Power-on resets. Leaves paused; explicitly resume. Stops at EOF without rerecording. Native load may reset/mutate on failure; no rollback, interruption, embedded ELF association or determinism guarantee.',
    replayOptions.shape, (input, extra) => run(() => startInputMovie(client(), input, 'replay', extra.signal)));
  server.tool('pcsx2_input_movie_status', 'Read/wait for an owned movie across reconnect. Verifies closed structure, actual frames and SHA256; replay also compares source and copy. A wait timeout/cancellation leaves recording active until its native limit. Historical completion does not attest current VM state.',
    { operation_id: watchId, wait_ms: z.number().int().min(0).max(30000).default(0) },
    ({ operation_id, wait_ms }, extra) => run(() => readInputMovie(client(), operation_id, wait_ms, extra.signal)));
  server.tool('pcsx2_input_movie_stop', 'Synchronously close only this movie ID and pause, restoring replay pad input. Does not stop a GUI/foreign recording. Status verifies any nonempty closed file afterward.',
    { operation_id: watchId }, ({ operation_id }) => run(() => client().inputMovieStatus(operation_id, true)));
  server.tool('pcsx2_input_movie_inspect', 'Inspect a bounded local p2m2 v1 header, complete two-port frame records and SHA256 without a connection. Does not prove the original ELF or deterministic execution. Savestate companions are not verified.',
    { path: z.string().min(1).max(4096) }, ({ path }, extra) => run(() => inspectMovie(path, extra.signal)));
  server.tool('pcsx2_input_state_inspect', 'Inspect a local pinned-v2.9.147 savestate companion without connecting or loading it. Verifies finalized bounded ZIP32 structure, required entries/sizes, decoded payload lengths/CRC32 and full-file SHA256 (optionally caller-pinned). Supports stored/Deflate/Zstandard data; Node 22.15+ required. No RAM/BIOS payload is returned. Does not prove native load success, ELF association, determinism or enable savestate movie startup.',
    inputStateOptions.shape, (input, extra) => run(() => inspectInputState(input, extra.signal)));
}
