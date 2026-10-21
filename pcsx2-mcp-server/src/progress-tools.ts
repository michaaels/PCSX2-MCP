import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { DebugServerClient } from './debug-server-client.js';
import { watchId } from './exceptions.js';
import { progressFields, progressOptions, parseProgressReport } from './progress.js';

export async function startProgressWatch(client: DebugServerClient, input: z.input<typeof progressOptions>, signal?: AbortSignal) {
  const options = progressOptions.parse(input);
  return client.withExclusiveSession(async () => {
    signal?.throwIfAborted();
    const caps = await client.getCapabilities();
    if (!caps.features.includes('ee_progress_watch') || caps.process_id === undefined || caps.execution_epoch === undefined)
      throw new Error('Rebuild PCSX2: ee_progress_watch capability and VM identity required');
    const id = randomUUID().replaceAll('-', '');
    try {
      const result = await client.startProgressWatch(id, { ...caps, process_id: caps.process_id, execution_epoch: caps.execution_epoch }, options);
      signal?.throwIfAborted();
      return { ...result, timeout_ms: options.timeout_ms, screenshot: options.screenshot, resumes_vm: false,
        action: 'pause_and_capture_on_configured_heartbeat_stall', retention: 'one_report_until_next_progress_watch_or_VM_shutdown' };
    } catch (error) {
      if (error instanceof Error && 'native_rejected' in error) throw error;
      let cleanup: unknown;
      try { cleanup = await client.progressWatchStatus(id, true); }
      catch (failure) { cleanup = { error: String(failure), pending_watch_id: id }; }
      throw Object.assign(new Error(`Progress watch start failed: ${String(error)}`), { cleanup });
    }
  });
}
export async function readProgressReport(client: DebugServerClient, id: string, waitMs = 0, signal?: AbortSignal) {
  watchId.parse(id); z.number().int().min(0).max(30000).parse(waitMs);
  const deadline = performance.now() + waitMs;
  for (;;) {
    signal?.throwIfAborted(); const result = await client.progressWatchStatus(id); signal?.throwIfAborted();
    if (result.state === 'captured') {
      const report = parseProgressReport(result.report);
      if (report.watch_id !== id || report.session !== result.session || report.execution_epoch !== result.execution_epoch ||
          report.elf !== result.elf || report.elf_crc !== result.elf_crc || JSON.stringify(report.criterion) !== JSON.stringify(result.criterion) ||
          report.unchanged_ms !== result.unchanged_ms || report.total_samples !== result.total_samples)
        throw new Error('Unexpected progress report identity/criterion');
      return { ...result, timed_out: false, report };
    }
    if (!result.active || performance.now() >= deadline) return { ...result, timed_out: result.active, report: null };
    await delay(Math.min(50, Math.max(1, deadline - performance.now())), undefined, { signal });
  }
}
export async function saveProgressReport(result: Awaited<ReturnType<typeof readProgressReport>>, output: string) {
  if (!result.report) return result;
  const base = path.resolve(output); await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'pcsx2-progress-'));
  const artifacts = { directory, report: path.join(directory, 'progress.json'), screenshot: undefined as string | undefined };
  let context = result.report.context;
  if (context.ok && context.screenshot.ok) {
    artifacts.screenshot = path.join(directory, 'frame.png');
    await fs.writeFile(artifacts.screenshot, Buffer.from(context.screenshot.data, 'base64'), { flag: 'wx' });
    context = { ...context, screenshot: { ...context.screenshot, data: '' } };
  }
  const saved = { ...result, report: { ...result.report, context }, artifacts };
  await fs.writeFile(artifacts.report, JSON.stringify(saved, null, 2), { flag: 'wx' }); return saved;
}
export function registerProgressTools(server: McpServer, getClient: () => DebugServerClient | null) {
  async function run(operation: (client: DebugServerClient) => Promise<unknown>) {
    try {
      const client = getClient(); if (!client?.isConnected()) throw new Error('Connect to DebugServer first');
      return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(client), null, 2) }] };
    } catch (error) { return { content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error),
      ...(error instanceof Error && 'cleanup' in error ? { cleanup: error.cleanup } : {}) }) }], isError: true }; }
  }
  server.tool('pcsx2_progress_watch_start', 'Observe one explicit 32-bit heartbeat in canonical EE RAM. Does not resume. While running with advancing EE cycles, unchanged masked heartbeat for stall_ms and at least 3 qualifying intervals pauses and captures bounded samples/context/logs/events/RAM and optional frame. Optional active_address gates observation: masked value must equal active_value; other values are expected waits. Pauses, breakpoints, execution operations, writes and sample gaps reset the window. Wall TTL continues while paused/disconnected. One shot, incompatible with an active exception watch. This observes a configured symptom, not a crash or deadlock cause. Requires a deliberately chosen progress signal; PC repetition alone is not used.',
    progressFields, (options, extra) => run(client => startProgressWatch(client, options, extra.signal)));
  server.tool('pcsx2_progress_report', 'Fetch/wait for an automatically captured heartbeat-stall report after reconnect. Never resumes or samples a new live context. Includes the configured criterion, bounded sample history, explicit partial evidence and terminal states. A wait timeout/cancellation leaves the native watch armed. Optional output_directory saves immutable JSON/PNG in a unique directory.',
    { watch_id: watchId, wait_ms: z.number().int().min(0).max(30000).default(0), output_directory: z.string().min(1).optional() },
    ({ watch_id, wait_ms, output_directory }, extra) => run(async client => {
      const result = await readProgressReport(client, watch_id, wait_ms, extra.signal);
      return output_directory ? saveProgressReport(result, output_directory) : result;
    }));
  server.tool('pcsx2_progress_watch_cancel', 'Disarm this progress watch ID only. Does not resume or clear breakpoints; an already captured report is retained.',
    { watch_id: watchId }, ({ watch_id }) => run(client => client.progressWatchStatus(watch_id, true)));
}
