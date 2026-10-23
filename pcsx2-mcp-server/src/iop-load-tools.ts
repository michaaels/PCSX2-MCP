import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { DebugServerClient } from './debug-server-client.js';
import { inspectIrx } from './irx.js';
import { watchId } from './exceptions.js';
import { loadFields, loadOptions, decodeLoadReceipt } from './iop-load.js';

export async function startIopLoadWatch(client: DebugServerClient, input: z.input<typeof loadOptions>, signal?: AbortSignal) {
  const options = loadOptions.parse(input);
  return client.withExclusiveSession(async () => {
    signal?.throwIfAborted(); const caps = await client.getCapabilities();
    if (!caps.features.includes('iop_load_provenance') || caps.process_id === undefined || caps.execution_epoch === undefined || caps.iop_reset_epoch === undefined)
      throw new Error('Rebuild PCSX2: iop_load_provenance and VM/IOP identities required');
    const file = await inspectIrx(options.irx);
    if (file.bytes.length > 1024 * 1024 || file.debugRelocationCount) throw new Error('Watch the actual loadable IRX, without file-only debug relocations; maximum 1 MiB');
    if (options.expected_sha256 && options.expected_sha256.toLowerCase() !== file.sha256) throw new Error('IRX SHA256 mismatch');
    const id = randomUUID().replaceAll('-', '');
    try {
      const state = await client.startIopLoadWatch(id, { ...caps, process_id: caps.process_id, execution_epoch: caps.execution_epoch, iop_reset_epoch: caps.iop_reset_epoch },
        { path: file.irx, sha256: file.sha256, size: file.bytes.length, prefix: file.bytes.subarray(0, 64).toString('hex'), timeout_ms: options.timeout_ms });
      signal?.throwIfAborted();
      const after = await inspectIrx(file.irx);
      if (after.sha256 !== file.sha256 || after.file_version !== file.file_version) throw new Error('IRX changed during arming');
      return { ...state, resumes_vm: false };
    } catch (error) {
      if (error instanceof Error && 'native_rejected' in error) throw error;
      let cleanup: unknown;
      try { cleanup = await client.iopLoadWatchStatus(id, true); } catch (failure) { cleanup = { error: String(failure), pending_watch_id: id }; }
      throw Object.assign(new Error(`IOP load watch failed: ${String(error)}`), { cleanup });
    }
  });
}
export async function readIopLoadReport(client: DebugServerClient, id: string, waitMs = 0, signal?: AbortSignal) {
  watchId.parse(id); z.number().int().min(0).max(30000).parse(waitMs); const deadline = performance.now() + waitMs;
  for (;;) {
    signal?.throwIfAborted(); const state = await client.iopLoadWatchStatus(id); signal?.throwIfAborted();
    if (state.state === 'registered') return { ...decodeLoadReceipt(state).summary, timed_out: false };
    if (!state.active || performance.now() >= deadline) { const { source_bytes_base64: omitted, ...summary } = state; return { ...summary, timed_out: state.active }; }
    await delay(Math.min(50, Math.max(1, deadline - performance.now())), undefined, { signal });
  }
}
export function registerIopLoadTools(server: McpServer, getClient: () => DebugServerClient | null) {
  async function run(operation: (client: DebugServerClient) => Promise<unknown>) {
    try {
      const client = getClient(); if (!client?.isConnected()) throw new Error('Connect to DebugServer first');
      return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(client), null, 2) }] };
    } catch (error) { return { content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error),
      ...(error instanceof Error && 'cleanup' in error ? { cleanup: error.cleanup } : {}) }) }], isError: true }; }
  }
  server.tool('pcsx2_iop_load_watch_start', 'Arm before the selected local IRX is opened through HostFs. Observe all bytes read from its actual descriptor, compare the full canonical buffer at loadcore import 23, then correlate import 16 module registration. Does not load, pause or resume. One owned watch, wall TTL, file <=1 MiB, no debug-only relocations. A receipt binds only to the first subsequent pause; resume/writes/reset/restore/later loads invalidate association. Other devices/buffer-only loaders and full module generations are outside this contract.',
    loadFields, (options, extra) => run(client => startIopLoadWatch(client, options, extra.signal)));
  server.tool('pcsx2_iop_load_report', 'Read/wait for immutable full-file provenance after reconnect. Verifies actual captured bytes SHA256 and loader/registration metadata, omitting raw file bytes from MCP output. Reports current pause-binding availability separately from historical evidence. Wait timeout/cancellation leaves watch armed.',
    { watch_id: watchId, wait_ms: z.number().int().min(0).max(30000).default(0) },
    ({ watch_id, wait_ms }, extra) => run(client => readIopLoadReport(client, watch_id, wait_ms, extra.signal)));
  server.tool('pcsx2_iop_load_watch_cancel', 'Disarm only this pending IOP load watch. Retains an already registered receipt. Does not resume or remove breakpoints.',
    { watch_id: watchId }, ({ watch_id }) => run(client => client.iopLoadWatchStatus(watch_id, true).then(({ source_bytes_base64: omitted, ...summary }) => summary)));
}
