import { z } from 'zod';
import { parseScreenshot } from './screenshot.js';

const cursor = z.number().int().nonnegative().safe();
export const eventTypes = ['vm_started', 'vm_stopping', 'paused', 'resumed', 'breakpoint', 'watchpoint', 'elf_load_requested', 'automation_completed', 'automation_interrupted'] as const;
export type DebugEventType = typeof eventTypes[number];
const event = z.object({
  sequence: cursor, timestamp_ms: cursor, type: z.enum(eventTypes),
  cpu: z.string(), pc: z.string(), detail: z.string(),
});
const log = z.object({
  sequence: cursor, timestamp_ms: cursor, source: z.string(),
  level: z.number().int(), message: z.string(), truncated: z.boolean(),
});
const history = z.object({
  ok: z.literal(true), session: cursor, oldest_sequence: cursor,
  dropped: z.boolean(), next_cursor: cursor,
});
export const eventsResponse = history.extend({ events: z.array(event).max(200) });
export const logsResponse = history.extend({ logs: z.array(log).max(200) });
export const capabilitiesResponse = z.object({
  ok: z.literal(true), protocol_version: z.number().int(), session: cursor,
  process_id: z.number().int().positive().optional(),
  execution_epoch: cursor.optional(),
  elf: z.string(), elf_crc: z.string(), features: z.array(z.string()),
});
export type Events = z.infer<typeof eventsResponse>;
export type Logs = z.infer<typeof logsResponse>;

export function parseContext(response: unknown) {
  const context = z.object({
    ok: z.literal(true), timestamp_ms: cursor, session: cursor,
    cpu: z.enum(['ee', 'iop']), was_running: z.boolean(), elf: z.string(), elf_crc: z.string(),
    status: z.object({ ok: z.literal(true), data: z.object({
      alive: z.boolean(), paused: z.boolean(), pc: z.string(), cycles: z.number(),
    }) }),
    read_registers: z.object({ ok: z.literal(true), data: z.record(z.unknown()) }),
    get_backtrace: z.object({ ok: z.literal(true), frames: z.array(z.unknown()) }),
    memory: z.object({ ok: z.literal(true), address: z.string(), length: z.number(), hex: z.string() }).optional(),
    recent_logs: logsResponse,
    screenshot: z.unknown(),
  }).parse(response);
  const screenshotError = z.object({ ok: z.literal(false), error: z.string() }).safeParse(context.screenshot);
  if (screenshotError.success) return { ...context, screenshot: screenshotError.data };
  return { ...context, screenshot: { ok: true as const, ...parseScreenshot(context.screenshot) } };
}
