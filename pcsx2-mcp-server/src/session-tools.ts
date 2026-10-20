import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DebugServerClient } from './debug-server-client.js';
import { eventTypes } from './debug-session.js';

const after = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0);
const limit = z.number().int().min(1).max(200).default(100);
const text = (value: unknown) => ({ type: 'text' as const, text: JSON.stringify(value, null, 2) });

export function registerSessionTools(server: McpServer, getClient: () => DebugServerClient | null) {
  server.resource('debug_sessions', 'ps2://debug_sessions', async () => ({
    contents: [{ uri: 'ps2://debug_sessions', mimeType: 'text/plain', text:
      'Session tools require the updated native DebugServer, not Pine. Use pcsx2_capabilities to check support.\n' +
      'History: start at after=0; continue with next_cursor. dropped=true means overwritten history.\n' +
      'Read events before resuming to obtain a cursor, then wait with that cursor for a new breakpoint/watchpoint.\n' +
      'pcsx2_wait_event does not resume the VM; after=0 includes historical events.\n' +
      'Console logs require enabling the guest EE/IOP console channels for guest output.\n' +
      'pcsx2_load_elf requests reset of an active VM; it does not launch PCSX2 or guarantee application readiness.\n' +
      'pcsx2_capture_context collects one paused CPU context and restores prior running/paused state.\n' +
      'A missing rendered frame yields partial context. Optional output_directory saves JSON/PNG in a new folder.\n',
    }],
  }));

  async function run(operation: (client: DebugServerClient) => Promise<any>) {
    try {
      const client = getClient();
      if (!client?.isConnected()) throw new Error('DebugServer not connected. Use pcsx2_connect first.');
      return await operation(client);
    } catch (error) {
      return { content: [text({ error: error instanceof Error ? error.message : String(error) })], isError: true };
    }
  }

  server.tool('pcsx2_capabilities', 'Get DebugServer protocol version, session, current ELF/CRC and supported session features. Requires the updated native patch.', {},
    () => run(async client => ({ content: [text(await client.getCapabilities())] })));

  server.tool('pcsx2_read_events', 'Read bounded VM/breakpoint/watchpoint history without consuming it. Pass next_cursor as after on the next call; dropped indicates overwritten history. Timestamps are Unix milliseconds.',
    { after, limit }, ({ after, limit }) => run(async client => ({ content: [text(await client.readEvents(after, limit))] })));

  server.tool('pcsx2_wait_event', 'Wait for a VM/breakpoint/watchpoint event with a deadline. after=0 includes retained historical events; use next_cursor from pcsx2_read_events to wait for new events. Does not resume the VM. Returns timed_out instead of a fabricated event.',
    { after, type: z.enum(eventTypes).optional(), timeout_ms: z.number().int().min(0).max(30000).default(10000) },
    ({ after, type, timeout_ms }, extra) => run(async client => ({ content: [text(await client.waitEvent({ after, type, timeoutMs: timeout_ms, signal: extra.signal }))] })));

  server.tool('pcsx2_read_logs', 'Read bounded console history captured since VM startup. INFO-or-higher messages; guest EE/IOP output requires enabling those console channels in PCSX2 settings. Filters consume the scanned page; continue with next_cursor. Does not capture arbitrary files or network traffic.',
    { after, limit, contains: z.string().max(256).optional(), max_level: z.number().int().min(1).max(3).default(3) },
    ({ after, limit, contains, max_level }) => run(async client => {
      const result = await client.readLogs(after, limit);
      return { content: [text({ ...result, logs: result.logs.filter(log => log.level <= max_level && (!contains || log.message.includes(contains))) })] };
    }));

  server.tool('pcsx2_load_elf', 'Request an ELF override and VM reset using an absolute path on the emulator host. Requires an already running or paused VM. Success means reset requested, not that the ELF reached its entry point. Existing breakpoints may need updating for the new build.',
    { path: z.string().min(1).max(4096) }, ({ path }) => run(async client => ({ content: [text(await client.loadElf(path))] })));

  server.tool('pcsx2_capture_context', 'Capture one paused CPU context: ELF/CRC, registers, backtrace, optional memory, recent console logs and GS screenshot. Restores prior running/paused state. A missing frame is reported as partial context. Optionally saves JSON and PNG in a new directory under output_directory.',
    {
      cpu: z.enum(['ee', 'iop']).default('ee'),
      width: z.number().int().min(1).max(1280).default(640),
      height: z.number().int().min(1).max(1024).default(480),
      memory_address: z.string().regex(/^(?:0x)?[\da-fA-F]{1,8}$/).default('0x0'),
      memory_length: z.number().int().min(0).max(4096).default(0),
      output_directory: z.string().min(1).optional(),
    }, ({ cpu, width, height, memory_address, memory_length, output_directory }) => run(async client => {
      const result = await client.captureContext({ cpu, width, height, memoryAddress: memory_address, memoryLength: memory_length });
      const { screenshot, ...context } = result;
      const report = { ...context, complete: screenshot.ok, screenshot: screenshot.ok
        ? { ok: true, width: screenshot.width, height: screenshot.height, mime_type: 'image/png' }
        : screenshot };
      let artifacts: { directory: string; report: string; screenshot?: string } | undefined;
      if (output_directory) {
        const base = path.resolve(output_directory);
        await fs.mkdir(base, { recursive: true });
        const directory = await fs.mkdtemp(path.join(base, 'pcsx2-context-'));
        artifacts = { directory, report: path.join(directory, 'context.json') };
        if (screenshot.ok) {
          artifacts.screenshot = path.join(directory, 'frame.png');
          await fs.writeFile(artifacts.screenshot, Buffer.from(screenshot.data, 'base64'), { flag: 'wx' });
        }
        await fs.writeFile(artifacts.report, JSON.stringify({ ...report, artifacts }, null, 2), { flag: 'wx' });
      }
      const content: ({ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string })[] = [text({ ...report, artifacts })];
      if (screenshot.ok) content.push({ type: 'image', mimeType: 'image/png', data: screenshot.data });
      return { content };
    }));
}
