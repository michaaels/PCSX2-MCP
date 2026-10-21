import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DebugServerClient } from './debug-server-client.js';
import { watchId } from './exceptions.js';
import { dumpOptions, verifyDump, type DumpOptions } from './gs-dump.js';

export async function cancelGsDump(client: DebugServerClient, id: string) {
  const deadline = performance.now() + 3000;
  let result = await client.gsDumpStatus(id, true);
  while (result.active && performance.now() < deadline) {
    await delay(25); result = await client.gsDumpStatus(id);
  }
  if (result.active) throw new Error(`GS dump cleanup could not be confirmed; query operation ${id}`);
  return result;
}

export async function startGsDump(client: DebugServerClient, input: DumpOptions = {}, signal?: AbortSignal) {
  const options = dumpOptions.parse(input);
  return client.withExclusiveSession(async () => {
    signal?.throwIfAborted();
    const caps = await client.getCapabilities();
    if (!caps.features.includes('gs_dump') || caps.process_id === undefined || caps.execution_epoch === undefined)
      throw new Error('Rebuild PCSX2: gs_dump and VM identity required');
    const id = randomUUID().replaceAll('-', '');
    try {
      const result = await client.startGsDump(id, { ...caps, process_id: caps.process_id, execution_epoch: caps.execution_epoch }, options);
      signal?.throwIfAborted(); return result;
    } catch (error) {
      if (error instanceof Error && 'native_rejected' in error) throw error;
      let cleanup: unknown;
      try { cleanup = await cancelGsDump(client, id); }
      catch (failure) { cleanup = { error: String(failure), pending_operation_id: id }; }
      throw Object.assign(new Error(`GS dump start failed: ${String(error)}`), { cleanup });
    }
  });
}

export async function readGsDump(client: DebugServerClient, id: string, waitMs = 0, signal?: AbortSignal) {
  watchId.parse(id); z.number().int().min(0).max(30000).parse(waitMs);
  const deadline = performance.now() + waitMs;
  for (;;) {
    signal?.throwIfAborted();
    const result = await client.gsDumpStatus(id);
    if (result.state === 'closed') {
      const artifact = await verifyDump(result.path, result.max_bytes, result.frames_requested, signal);
      if (artifact.bytes !== result.bytes_submitted) throw new Error('GS dump file size differs from native writes');
      const confirmed = await client.gsDumpStatus(id);
      if (JSON.stringify(confirmed) !== JSON.stringify(result)) throw new Error('GS dump changed while verifying its file');
      return { ...result, timed_out: false, artifact };
    }
    if (!result.active || performance.now() >= deadline) return { ...result, timed_out: result.active, artifact: { verified: false } };
    await delay(50, undefined, { signal });
  }
}

export function registerGsDumpTools(server: McpServer, getClient: () => DebugServerClient | null) {
  async function run(operation: (client: DebugServerClient) => Promise<unknown>) {
    try {
      const client = getClient(); if (!client?.isConnected()) throw new Error('Connect to DebugServer first');
      return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(client), null, 2) }] };
    } catch (error) { return { content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error),
      ...(error instanceof Error && 'cleanup' in error ? { cleanup: error.cleanup } : {}) }) }], isError: true }; }
  }
  server.tool('pcsx2_gs_dump_start', 'Queue an owned uncompressed GS dump of 1-300 requested video boundaries, with wall timeout and hard byte limit. Does not resume emulation. Refuses an existing GUI dump/snapshot; writes a unique .gs file under the instance data root. No audio or CPU execution replay is implied.',
    dumpOptions.shape, (input, extra) => run(client => startGsDump(client, input, extra.signal)));
  server.tool('pcsx2_gs_dump_status', 'Read/wait for this dump ID, including after reconnect. Closed dumps are read and checked for header extents, packet boundaries and minimum VSync count, then hashed. Merely existing/partial files are never verified. Wait timeout/cancellation leaves the native operation running until its own deadline.',
    { operation_id: watchId, wait_ms: z.number().int().min(0).max(30000).default(0) },
    ({ operation_id, wait_ms }, extra) => run(client => readGsDump(client, operation_id, wait_ms, extra.signal)));
  server.tool('pcsx2_gs_dump_cancel', 'Cancel only this owned GS dump, clear its pending snapshot and await native cleanup. Preserves GUI dumps and already completed files. Does not pause/resume the VM.',
    { operation_id: watchId }, ({ operation_id }) => run(client => cancelGsDump(client, operation_id)));
}
