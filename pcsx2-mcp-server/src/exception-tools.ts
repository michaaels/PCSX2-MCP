import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { DebugServerClient } from './debug-server-client.js';
import { exceptionOptions, watchId, parseExceptionReport } from './exceptions.js';

export async function startExceptionWatch(client: DebugServerClient, input: z.input<typeof exceptionOptions>, signal?: AbortSignal) {
  const options = exceptionOptions.parse(input);
  return client.withExclusiveSession(async () => {
    signal?.throwIfAborted();
    const caps = await client.getCapabilities();
    if (!caps.features.includes('ee_exception_watch') || caps.process_id === undefined || caps.execution_epoch === undefined) throw new Error('Rebuild PCSX2: ee_exception_watch capability required');
    const id = randomUUID().replaceAll('-', '');
    try {
      const result = await client.startExceptionWatch(id, { ...caps, process_id: caps.process_id, execution_epoch: caps.execution_epoch }, options);
      signal?.throwIfAborted();
      return { ...result, exception_codes: [...new Set(options.exception_codes)], timeout_ms: options.timeout_ms, screenshot: options.screenshot,
        resumes_vm: false, retention: 'one_report_until_next_watch_or_VM_shutdown' };
    } catch (error) {
      if (error instanceof Error && 'native_rejected' in error) throw error;
      let cleanup: unknown;
      try { cleanup = await client.exceptionWatchStatus(id, true); }
      catch (failure) { cleanup = { error: String(failure), pending_watch_id: id }; }
      throw Object.assign(new Error(`Exception watch start failed: ${String(error)}`), { cleanup });
    }
  });
}

export async function readExceptionReport(client: DebugServerClient, id: string, waitMs = 0, signal?: AbortSignal) {
  watchId.parse(id); z.number().int().min(0).max(30000).parse(waitMs);
  const deadline = performance.now() + waitMs;
  for (;;) {
    signal?.throwIfAborted();
    const result = await client.exceptionWatchStatus(id);
    signal?.throwIfAborted();
    if (result.state === 'captured') {
      const report = parseExceptionReport(result.report);
      if (report.watch_id !== id || report.session !== result.session || report.execution_epoch !== result.execution_epoch ||
          report.elf !== result.elf || Number(report.elf_crc) !== Number(result.elf_crc)) throw new Error('Unexpected exception report identity');
      return { ...result, timed_out: false, report };
    }
    if (!result.active || performance.now() >= deadline) return { ...result, report: null, timed_out: result.active };
    await delay(Math.min(50, Math.max(1, deadline - performance.now())), undefined, { signal });
  }
}

export async function saveExceptionReport(result: Awaited<ReturnType<typeof readExceptionReport>>, output: string) {
  if (!result.report) return result;
  const report = result.report;
  const base = path.resolve(output); await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'pcsx2-exception-'));
  const artifacts = { directory, report: path.join(directory, 'exception.json'), screenshot: undefined as string | undefined };
  let context = report.context;
  if (context.ok && context.screenshot.ok) {
    artifacts.screenshot = path.join(directory, 'frame.png');
    await fs.writeFile(artifacts.screenshot, Buffer.from(context.screenshot.data, 'base64'), { flag: 'wx' });
    context = { ...context, screenshot: { ...context.screenshot, data: '' } };
  }
  await fs.writeFile(artifacts.report, JSON.stringify({ ...result, report: { ...report, context }, artifacts }, null, 2), { flag: 'wx' });
  return { ...result, report: { ...report, context }, artifacts };
}

export function registerExceptionTools(server: McpServer, getClient: () => DebugServerClient | null) {
  async function run(operation: (client: DebugServerClient) => Promise<unknown>) {
    try {
      const client = getClient(); if (!client?.isConnected()) throw new Error('Connect to DebugServer first');
      return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(client), null, 2) }] };
    } catch (error) { return { content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error),
      ...(error instanceof Error && 'cleanup' in error ? { cleanup: error.cleanup } : {}) }) }], isError: true }; }
  }
  server.tool('pcsx2_exception_watch_start', 'Arm one bounded native EE exception capture for the loaded VM/ELF. Does not resume. Default codes exclude interrupts, TLB refills and syscalls. A matching observation pauses the VM and freezes PC, CP0/GPRs, bounded code/stack RAM, context/backtrace/logs/events and optional frame. One shot; expires after timeout_ms. Survives client disconnect, retaining one report until another watch or VM shutdown. Not a fatal-fault classifier. Return watch_id is required for fetch/cancel.',
    exceptionOptions.shape, (options, extra) => run(client => startExceptionWatch(client, options, extra.signal)));
  server.tool('pcsx2_exception_report', 'Read/wait for the immutable report of a watch_id, including after reconnect. Native capture is automatic; this call never resumes or captures a new live VM context. Returns explicit expiry/cancel/VM-change/wait timeout, partial context and memory unavailability. instruction_evidence identifies verified EE recompiler BREAK call-site PC/opcode/BD separately from raw exception PC/CP0; consistency reports disagreement without repairing architectural state. Other paths may lack provenance. Cancelling this wait leaves the watch armed until its TTL or explicit cancel. Optional output_directory saves JSON/PNG in a unique directory.',
    { watch_id: watchId, wait_ms: z.number().int().min(0).max(30000).default(0), output_directory: z.string().min(1).optional() },
    ({ watch_id, wait_ms, output_directory }, extra) => run(async client => {
      const result = await readExceptionReport(client, watch_id, wait_ms, extra.signal);
      return output_directory ? saveExceptionReport(result, output_directory) : result;
    }));
  server.tool('pcsx2_exception_watch_cancel', 'Disarm this watch_id only. Does not resume the VM, clear breakpoints or delete a captured report; if capture won the race, its frozen report remains available.',
    { watch_id: watchId }, ({ watch_id }) => run(client => client.exceptionWatchStatus(watch_id, true)));
}
