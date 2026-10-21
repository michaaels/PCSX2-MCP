import { z } from 'zod';
import { address } from './symbols.js';
import { eventsResponse, parseContext } from './debug-session.js';

export const watchId = z.string().regex(/^[\da-f]{32}$/);
export const exceptionOptions = z.object({
  exception_codes: z.array(z.number().int().min(0).max(31)).min(1).max(32).default([4, 5, 6, 7, 9, 10, 11, 12, 13]),
  timeout_ms: z.number().int().min(100).max(300000).default(30000), screenshot: z.boolean().default(true),
});
const counter = z.number().int().nonnegative().safe();
export const exceptionState = z.object({ ok: z.literal(true), watch_id: watchId,
  state: z.enum(['armed', 'capturing', 'captured', 'expired', 'cancelled', 'vm_changed', 'vm_stopped']), active: z.boolean(),
  session: counter, execution_epoch: counter, elf: z.string(), elf_crc: address, report: z.unknown().nullable() });
const memory = z.object({ address, length: z.number().int().min(1).max(256), valid: z.boolean(), hex: z.string().regex(/^(?:[\da-f]{2})+$/).optional(), reason: z.string().optional() });
export function parseExceptionReport(value: unknown) {
  const report = z.object({ watch_id: watchId, cpu: z.literal('ee'), timestamp_ms: counter,
    session: counter, execution_epoch: counter, elf: z.string(), elf_crc: address, context_matches_stop: z.boolean(), screenshot_requested: z.boolean(),
    core: z.object({ exception_pc: address, post_exception_pc: address, raw_code: address, exception_code: z.number().int().min(0).max(31),
      requested_branch_delay: z.boolean(), previous_exl: z.boolean(), cause: address, epc: address, bad_vaddr: address, status: address,
      bad_vaddr_relevant: z.boolean(), gpr: z.array(z.string().regex(/^(?:0x)?[\da-fA-F]{32}$/).transform(value => '0x' + value.replace(/^0x/, '').toLowerCase())).length(32), cp0: z.array(address).length(32) }),
    memory: z.object({ code: memory.optional(), stack: memory.optional() }), events: eventsResponse.optional(), context: z.unknown(),
  }).parse(value);
  if (report.core.exception_code !== ((Number(report.core.raw_code) >>> 2) & 31)) throw new Error('Inconsistent exception code');
  for (const [name, reg] of [['cause', 13], ['epc', 14], ['bad_vaddr', 8], ['status', 12]] as const) {
    if (Number(report.core[name]) !== Number(report.core.cp0[reg])) throw new Error('Inconsistent exception CP0 registers');
  }
  for (const window of [report.memory.code, report.memory.stack]) {
    if (window && ((window.valid && window.hex?.length !== window.length * 2) || (!window.valid && window.hex !== undefined))) throw new Error('Invalid exception memory window');
  }
  const failure = z.object({ ok: z.literal(false), error: z.string() }).safeParse(report.context);
  const context = failure.success ? failure.data : parseContext(report.context);
  if (report.events && report.events.session !== report.session) throw new Error('Exception event history session mismatch');
  if (context.ok && (context.cpu !== 'ee' || context.session !== report.session || context.elf !== report.elf || Number(context.elf_crc) !== Number(report.elf_crc) ||
      !context.status.data.paused || Number(context.status.data.pc) !== Number(report.core.post_exception_pc))) throw new Error('Exception context identity/PC mismatch');
  const partial = [
    ...(!report.context_matches_stop ? ['paused_state_changed_before_extended_capture'] : []),
    ...(!context.ok ? [context.error] : report.screenshot_requested && !context.screenshot.ok ? [context.screenshot.error] : []),
    ...(['code', 'stack'] as const).filter(key => !report.memory[key]?.valid).map(key => `${key}_memory_unavailable`),
    ...(!report.events ? ['event_history_unavailable'] : []),
  ];
  return { ...report, context, observation: 'configured_ee_exception' as const,
    pc_semantics: 'cpuException_entry_PC_not_independently_verified_faulting_instruction' as const,
    branch_delay_semantics: 'cpuException_bd_argument' as const,
    complete: partial.length === 0, partial_reasons: partial };
}
