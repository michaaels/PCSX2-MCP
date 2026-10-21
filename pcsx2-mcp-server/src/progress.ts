import { z } from 'zod';
import { address } from './symbols.js';
import { watchId } from './exceptions.js';
import { eventsResponse, parseContext } from './debug-session.js';

const count = z.number().int().nonnegative().safe();
const word = z.number().int().min(0).max(0xffffffff);
const ramWord = address.refine(value => Number(value) <= 0x1fffffc && (Number(value) & 3) === 0, 'Aligned canonical EE RAM word required');
export const progressFields = {
  heartbeat_address: ramWord, heartbeat_mask: word.min(1).default(0xffffffff),
  active_address: ramWord.optional(), active_mask: word.min(1).default(0xffffffff), active_value: word.default(1),
  sample_interval_ms: z.number().int().min(50).max(1000).default(100),
  stall_ms: z.number().int().min(150).max(60000).default(1000),
  timeout_ms: z.number().int().min(100).max(300000).default(30000),
  max_samples: z.number().int().min(8).max(64).default(64), screenshot: z.boolean().default(true),
};
export const progressOptions = z.object(progressFields).refine(o => o.stall_ms >= 3 * o.sample_interval_ms,
  'stall_ms must cover at least three sample intervals').refine(o => ((o.active_value & ~o.active_mask) >>> 0) === 0,
  'active_value must fit active_mask');
export const progressCriterion = z.object({ heartbeat_address: ramWord, heartbeat_mask: address,
  active_address: ramWord.nullable(), active_mask: address, active_value: address,
  sample_interval_ms: progressFields.sample_interval_ms, stall_ms: progressFields.stall_ms,
  max_sample_gap_ms: z.number().int().min(200).max(4000), max_samples: progressFields.max_samples });
function validateCriterion(c: z.infer<typeof progressCriterion>) {
  if (Number(c.heartbeat_mask) === 0 || Number(c.active_mask) === 0 ||
      ((Number(c.active_value) & ~Number(c.active_mask)) >>> 0) !== 0 || c.stall_ms < c.sample_interval_ms * 3 ||
      c.max_sample_gap_ms !== c.sample_interval_ms * 4) throw new Error('Invalid progress criterion');
}
export const progressState = z.object({ ok: z.literal(true), watch_id: watchId, cpu: z.literal('ee'),
  state: z.enum(['armed', 'capturing', 'captured', 'expired', 'cancelled', 'vm_changed', 'vm_stopped', 'memory_unavailable']),
  active: z.boolean(), session: count, execution_epoch: count, elf: z.string(), elf_crc: address,
  criterion: progressCriterion, unchanged_ms: count, total_samples: count, report: z.unknown().nullable(),
}).superRefine((s, ctx) => {
  validateCriterion(s.criterion);
  if (s.active !== ['armed', 'capturing'].includes(s.state) || (s.state === 'captured') !== (s.report !== null))
    ctx.addIssue({ code: 'custom', message: 'Inconsistent progress watch state' });
});
const sample = z.object({ timestamp_ms: count, elapsed_ms: count, pc: address, cycles: address,
  heartbeat: address.nullable(), active_value: address.nullable(),
  phase: z.enum(['baseline', 'progress', 'unchanged', 'paused', 'execution_operation', 'unreadable', 'expected_wait', 'sampling_gap', 'cycles_not_advanced']) });
const memory = z.object({ address, length: z.number().int().min(1).max(256), valid: z.boolean(),
  hex: z.string().regex(/^(?:[\da-f]{2})+$/).optional(), reason: z.string().optional() });
export function parseProgressReport(value: unknown) {
  const r = z.object({ watch_id: watchId, cpu: z.literal('ee'), observation: z.literal('configured_heartbeat_stall'),
    timestamp_ms: count, session: count, execution_epoch: count, elf: z.string(), elf_crc: address,
    criterion: progressCriterion, unchanged_ms: count, unchanged_intervals: count, stop_pc: address, stop_cycles: address,
    screenshot_requested: z.boolean(), context_matches_stop: z.boolean(), total_samples: count, samples_dropped: count,
    samples: z.array(sample).min(4).max(64), memory: z.object({ code: memory.optional(), stack: memory.optional() }),
    events: eventsResponse, context: z.unknown(),
  }).parse(value);
  validateCriterion(r.criterion);
  if (r.unchanged_ms < r.criterion.stall_ms || r.unchanged_intervals < 3 || r.samples.length > r.criterion.max_samples ||
      r.samples_dropped + r.samples.length !== r.total_samples || r.events.session !== r.session ||
      r.samples.at(-1)!.phase !== 'unchanged') throw new Error('Inconsistent progress observation');
  let retainedMs = 0, retainedIntervals = 0;
  for (let i = 0; i < r.samples.length; i++) {
    const s = r.samples[i], p = r.samples[i - 1];
    if (p && s.elapsed_ms <= p.elapsed_ms) throw new Error('Non-monotonic progress samples');
    if ((s.heartbeat !== null && ((Number(s.heartbeat) & ~Number(r.criterion.heartbeat_mask)) >>> 0) !== 0) ||
        (s.active_value !== null && (r.criterion.active_address === null || ((Number(s.active_value) & ~Number(r.criterion.active_mask)) >>> 0) !== 0)))
      throw new Error('Progress sample exceeds configured mask');
    if (s.phase !== 'unchanged') { retainedMs = 0; retainedIntervals = 0; continue; }
    if (s.heartbeat === null || (r.criterion.active_address !== null && s.active_value !== r.criterion.active_value))
      throw new Error('Unqualified unchanged heartbeat');
    if (p) {
      const gap = s.elapsed_ms - p.elapsed_ms;
      if (!['baseline', 'progress', 'unchanged'].includes(p.phase) || s.heartbeat !== p.heartbeat || s.cycles === p.cycles ||
          gap > r.criterion.max_sample_gap_ms) throw new Error('Invalid unchanged sample interval');
      retainedMs += gap; retainedIntervals++;
    }
  }
  const fullyRetained = retainedIntervals === r.unchanged_intervals;
  if (retainedMs > r.unchanged_ms || retainedIntervals > r.unchanged_intervals ||
      (fullyRetained && retainedMs !== r.unchanged_ms) || (!fullyRetained && r.samples_dropped === 0))
    throw new Error('Progress streak does not match samples');
  for (const w of [r.memory.code, r.memory.stack]) if (w &&
    ((w.valid && (w.hex?.length !== w.length * 2 || Number(w.address) + w.length > 0x2000000)) || (!w.valid && w.hex !== undefined)))
    throw new Error('Invalid progress memory window');
  const failure = z.object({ ok: z.literal(false), error: z.string() }).safeParse(r.context);
  const context = failure.success ? failure.data : parseContext(r.context);
  if (context.ok && (!r.context_matches_stop || context.cpu !== 'ee' || context.session !== r.session || context.elf !== r.elf ||
      Number(context.elf_crc) !== Number(r.elf_crc) || !context.status.data.paused || Number(context.status.data.pc) !== Number(r.stop_pc) ||
      context.status.data.cycles !== Number(r.stop_cycles))) throw new Error('Progress context identity/stop mismatch');
  const partial = [...(!r.context_matches_stop ? ['paused_state_changed_during_capture'] : []),
    ...(!context.ok ? [context.error] : r.screenshot_requested && !context.screenshot.ok ? [context.screenshot.error] : []),
    ...(['code', 'stack'] as const).filter(key => !r.memory[key]?.valid).map(key => `${key}_memory_unavailable`),
    ...(!fullyRetained ? ['progress_streak_start_not_retained'] : [])];
  return { ...r, context, streak_fully_retained: fullyRetained, complete: partial.length === 0, partial_reasons: partial,
    interpretation: 'Configured heartbeat unchanged while EE cycles advanced; legitimate work or waits may have the same symptom. Cause is undetermined.' };
}
