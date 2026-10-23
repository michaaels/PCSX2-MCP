import { z } from 'zod';
import { address } from './symbols.js';
import { watchId } from './exceptions.js';

const count = z.number().int().nonnegative().safe();
export const memoryWatchFields = {
  cpu: z.enum(['ee', 'iop']).default('ee'), address,
  size: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(4),
  mask: z.number().int().min(1).max(0xffffffff).optional(),
  sample_interval_ms: z.number().int().min(50).max(1000).default(100),
  timeout_ms: z.number().int().min(100).max(300000).default(30000),
  pause_on_change: z.boolean().default(false),
};
export const memoryWatchOptions = z.object(memoryWatchFields).superRefine((o, ctx) => {
  if (Number(o.address) % o.size || Number(o.address) + o.size > (o.cpu === 'iop' ? 0x200000 : 0x2000000))
    ctx.addIssue({ code: 'custom', message: 'Aligned canonical RAM range required' });
  if (o.mask !== undefined && o.mask > 2 ** (o.size * 8) - 1)
    ctx.addIssue({ code: 'custom', message: 'Mask exceeds value width' });
});
const sample = z.object({ timestamp_ms: count, elapsed_ms: count, sample_pc: address, cycles: address, raw: address, masked: address });
export const memoryWatchState = z.object({ ok: z.literal(true), watch_id: watchId,
  state: z.enum(['armed', 'changed', 'expired', 'cancelled', 'vm_changed', 'vm_stopped', 'cpu_reset', 'memory_unavailable', 'lifetime_changed']),
  active: z.boolean(), session: count, execution_epoch: count, iop_reset_epoch: count,
  elf: z.string(), elf_crc: address, cpu: z.enum(['ee', 'iop']), address,
  size: memoryWatchFields.size, mask: address, sample_interval_ms: memoryWatchFields.sample_interval_ms,
  timeout_ms: memoryWatchFields.timeout_ms, pause_on_change: z.boolean(),
  total_samples: count, baseline_count: count, sampling_cpu_ns: count,
  observation: z.literal('sampled_memory_change'), writer_pc: z.null(),
  change: z.object({ previous: sample, current: sample }).nullable(),
}).superRefine((w, ctx) => {
  memoryWatchOptions.parse({ ...w, mask: Number(w.mask) });
  let bad = w.active !== (w.state === 'armed') || (w.state === 'changed') !== (w.change !== null) ||
    w.baseline_count > w.total_samples;
  if (w.change) {
    const { previous: p, current: c } = w.change;
    const gap = c.elapsed_ms - p.elapsed_ms;
    bad ||= w.total_samples < 2 || w.baseline_count < 1 || gap <= 0 || gap > w.sample_interval_ms * 4 ||
      c.cycles === p.cycles || c.masked === p.masked || c.elapsed_ms >= w.timeout_ms;
    for (const s of [p, c]) bad ||= Number(s.raw) > 2 ** (w.size * 8) - 1 ||
      ((Number(s.raw) & Number(w.mask)) >>> 0) !== Number(s.masked);
  }
  if (bad) ctx.addIssue({ code: 'custom', message: 'Inconsistent memory change observation' });
});
export const memoryWatchList = z.object({ ok: z.literal(true), capacity: z.literal(16), watches: z.array(memoryWatchState).max(16) })
  .refine(r => new Set(r.watches.map(w => w.watch_id)).size === r.watches.length, 'Duplicate memory watch IDs');
