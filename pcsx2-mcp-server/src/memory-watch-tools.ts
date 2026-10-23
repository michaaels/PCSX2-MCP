import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { DebugServerClient } from './debug-server-client.js';
import { watchId } from './exceptions.js';
import { memoryWatchFields, memoryWatchOptions } from './memory-watch.js';

export async function startMemoryWatch(client: DebugServerClient, input: z.input<typeof memoryWatchOptions>, signal?: AbortSignal) {
  const options = memoryWatchOptions.parse(input);
  return client.withExclusiveSession(async () => {
    signal?.throwIfAborted();
    const caps = await client.getCapabilities();
    if (!caps.features.includes('memory_change_watch') || caps.process_id === undefined || caps.execution_epoch === undefined ||
        (options.cpu === 'iop' && caps.iop_reset_epoch === undefined)) throw new Error('Rebuild PCSX2: memory_change_watch and VM identity required');
    const id = randomUUID().replaceAll('-', '');
    try {
      const result = await client.startMemoryWatch(id, { ...caps, process_id: caps.process_id, execution_epoch: caps.execution_epoch }, options);
      signal?.throwIfAborted();
      return { ...result, resumes_vm: false };
    } catch (error) {
      if (error instanceof Error && 'native_rejected' in error) throw error;
      let cleanup: unknown;
      try { cleanup = await client.memoryWatchStatus(id, true); }
      catch (failure) { cleanup = { error: String(failure), pending_watch_id: id }; }
      throw Object.assign(new Error(`Memory watch start failed: ${String(error)}`), { cleanup });
    }
  });
}
export async function waitMemoryWatch(client: DebugServerClient, id: string, waitMs = 0, signal?: AbortSignal) {
  watchId.parse(id); z.number().int().min(0).max(30000).parse(waitMs);
  const deadline = performance.now() + waitMs;
  for (;;) {
    signal?.throwIfAborted(); const result = await client.memoryWatchStatus(id); signal?.throwIfAborted();
    if (!result.active || performance.now() >= deadline) return { ...result, timed_out: result.active };
    await delay(Math.min(50, Math.max(1, deadline - performance.now())), undefined, { signal });
  }
}
export function registerMemoryWatchTools(server: McpServer, getClient: () => DebugServerClient | null) {
  async function run(operation: (client: DebugServerClient) => Promise<unknown>) {
    try {
      const client = getClient(); if (!client?.isConnected()) throw new Error('Connect to DebugServer first');
      return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(client), null, 2) }] };
    } catch (error) { return { content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error),
      ...(error instanceof Error && 'cleanup' in error ? { cleanup: error.cleanup } : {}) }) }], isError: true }; }
  }
  server.tool('pcsx2_memory_watch_start', 'Observe the first masked value change between CPU-thread samples of aligned canonical EE/IOP RAM (1/2/4 bytes). Up to 16 watches; oldest terminal entry evicted when full. Does not resume. Optional pause_on_change. Pauses, MCP writes, execution operations and gaps >4 intervals rebase. Wall TTL continues disconnected/paused. Frozen pair includes sample PCs/cycles, never exact writer PC. Can miss transient changes. ELF affinity and IOP CPU reset guard do not identify an IRX generation or protect savestate/software SifIopReset. Incompatible with active progress/exception watches.',
    memoryWatchFields, (options, extra) => run(client => startMemoryWatch(client, options, extra.signal)));
  server.tool('pcsx2_memory_watch_status', 'Fetch/wait for one memory observer. Wait cancellation/timeout leaves it armed. A changed pair is retained until eviction/shutdown, including across ELF resets. No fresh context or exact-writer claim.',
    { watch_id: watchId, wait_ms: z.number().int().min(0).max(30000).default(0) },
    ({ watch_id, wait_ms }, extra) => run(client => waitMemoryWatch(client, watch_id, wait_ms, extra.signal)));
  server.tool('pcsx2_memory_watch_list', 'List at most 16 retained memory observers and their immutable change pairs; does not sample memory or resume.',
    {}, () => run(client => client.listMemoryWatches()));
  server.tool('pcsx2_memory_watch_cancel', 'Cancel only this memory watch ID. Preserves a completed change pair; never resumes or clears breakpoints.',
    { watch_id: watchId }, ({ watch_id }) => run(client => client.memoryWatchStatus(watch_id, true)));
}
