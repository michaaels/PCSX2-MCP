import { z } from 'zod';
import { address } from './symbols.js';
import { eventsResponse, parseContext } from './debug-session.js';

export const watchId = z.string().regex(/^[\da-f]{32}$/);
export const exceptionOptions = z.object({
  cpu: z.enum(['ee', 'iop']).default('ee'),
  exception_codes: z.array(z.number().int().min(0).max(31)).min(1).max(32).default([4, 5, 6, 7, 9, 10, 11, 12, 13]),
  timeout_ms: z.number().int().min(100).max(300000).default(30000), screenshot: z.boolean().default(true),
});
const counter = z.number().int().nonnegative().safe();
export const exceptionState = z.object({ ok: z.literal(true), watch_id: watchId,
  cpu: z.enum(['ee', 'iop']).default('ee'), iop_reset_epoch: counter.optional(),
  iop_reset_scope: z.literal('cpu_reset_only').optional(),
  state: z.enum(['armed', 'capturing', 'captured', 'expired', 'cancelled', 'vm_changed', 'vm_stopped', 'cpu_reset']), active: z.boolean(),
  session: counter, execution_epoch: counter, elf: z.string(), elf_crc: address, report: z.unknown().nullable() });
const memory = z.object({ address, length: z.number().int().min(1).max(256), valid: z.boolean(), hex: z.string().regex(/^(?:[\da-f]{2})+$/).optional(), reason: z.string().optional() });
const instructionOrigin = z.object({ source: z.enum(['ee_recompiler_break', 'ee_recompiler_syscall', 'iop_recompiler_break', 'iop_recompiler_syscall']), pc: address, opcode: address,
  branch_delay: z.boolean(), opcode_matches_memory: z.boolean() });
export function parseExceptionReport(value: unknown) {
  const report = z.object({ watch_id: watchId, cpu: z.enum(['ee', 'iop']), timestamp_ms: counter,
    iop_reset_epoch: counter.optional(), elf_role: z.enum(['ee_executable', 'ee_boot_affinity_only']).optional(), module_identity: z.null().optional(),
    iop_reset_scope: z.literal('cpu_reset_only').optional(),
    session: counter, execution_epoch: counter, elf: z.string(), elf_crc: address, context_matches_stop: z.boolean(), screenshot_requested: z.boolean(),
    core: z.object({ exception_pc: address, post_exception_pc: address, raw_code: address, exception_code: z.number().int().min(0).max(31),
      requested_branch_delay: z.boolean(), previous_exl: z.boolean().nullable(), previous_status: address.optional(), hi: address.optional(), lo: address.optional(),
      cause: address, epc: address, bad_vaddr: address, status: address,
      bad_vaddr_relevant: z.boolean(), instruction: instructionOrigin.nullable().optional(),
      gpr: z.array(z.string().regex(/^(?:0x)?[\da-fA-F]{32}$/).transform(value => '0x' + value.replace(/^0x/, '').toLowerCase())).length(32), cp0: z.array(address).length(32) }),
    memory: z.object({ code: memory.optional(), stack: memory.optional() }), events: eventsResponse.optional(), context: z.unknown(),
  }).parse(value);
  if (report.core.exception_code !== ((Number(report.core.raw_code) >>> 2) & 31)) throw new Error('Inconsistent exception code');
  if (report.cpu === 'iop') {
    if (report.iop_reset_epoch === undefined || report.iop_reset_scope !== 'cpu_reset_only' || report.elf_role !== 'ee_boot_affinity_only' || report.module_identity !== null ||
      report.core.previous_exl !== null || report.core.previous_status === undefined || report.core.hi === undefined || report.core.lo === undefined ||
      report.core.gpr.some(value => BigInt(value) > 0xffffffffn)) throw new Error('Invalid IOP identity/register semantics');
    const before = Number(report.core.previous_status);
    if (Number(report.core.status) !== (((before & ~63) | ((before & 15) << 2)) >>> 0)) throw new Error('Invalid IOP Status mode stack');
  } else if (report.core.previous_exl === null) throw new Error('EE requires previous EXL');
  for (const [name, reg] of [['cause', 13], ['epc', 14], ['bad_vaddr', 8], ['status', 12]] as const) {
    if (Number(report.core[name]) !== Number(report.core.cp0[reg])) throw new Error('Inconsistent exception CP0 registers');
  }
  const origin = report.core.instruction;
  if (origin) {
    const syscall = origin.source.endsWith('_syscall');
    if (!origin.source.startsWith(report.cpu + '_') || report.core.exception_code !== (syscall ? 8 : 9) ||
        (Number(origin.pc) & 3) !== 0 || (Number(origin.opcode) & 0xfc00003f) !== (syscall ? 12 : 13))
      throw new Error('Invalid trap instruction provenance');
    if (origin.opcode_matches_memory && Number(origin.pc) + 4 > (report.cpu === 'iop' ? 0x200000 : 0x2000000))
      throw new Error('Verified trap provenance outside canonical RAM');
  }
  const instructionEvidence = origin ? { ...origin, status: origin.opcode_matches_memory ? 'verified' as const : 'unverified' as const,
    ...(!origin.opcode_matches_memory ? { reason: 'opcode_unreadable_excluded_or_changed' } : {}),
    consistency: {
      entry_pc_matches: Number(report.core.exception_pc) === Number(origin.pc),
      bd_argument_matches: report.core.requested_branch_delay === origin.branch_delay,
      epc_matches: report.core.previous_exl ? null : Number(report.core.epc) === ((Number(origin.pc) - (origin.branch_delay ? 4 : 0)) >>> 0),
      cause_bd_matches: report.core.previous_exl ? null : (Number(report.core.cause) >>> 31) === Number(origin.branch_delay),
    } } : { status: 'unavailable' as const, reason: 'exception_path_has_no_instruction_provenance' };
  for (const window of [report.memory.code, report.memory.stack]) {
    if (window && ((window.valid && (window.hex?.length !== window.length * 2 || Number(window.address) + window.length > (report.cpu === 'iop' ? 0x200000 : 0x2000000))) ||
      (!window.valid && window.hex !== undefined))) throw new Error('Invalid exception memory window');
  }
  const failure = z.object({ ok: z.literal(false), error: z.string() }).safeParse(report.context);
  const context = failure.success ? failure.data : parseContext(report.context);
  if (report.events && report.events.session !== report.session) throw new Error('Exception event history session mismatch');
  if (context.ok && (context.cpu !== report.cpu || context.session !== report.session || context.elf !== report.elf || Number(context.elf_crc) !== Number(report.elf_crc) ||
      !context.status.data.paused || Number(context.status.data.pc) !== Number(report.core.post_exception_pc))) throw new Error('Exception context identity/PC mismatch');
  const partial = [
    ...(!report.context_matches_stop ? ['paused_state_changed_before_extended_capture'] : []),
    ...(!context.ok ? [context.error] : report.screenshot_requested && !context.screenshot.ok ? [context.screenshot.error] : []),
    ...(['code', 'stack'] as const).filter(key => !report.memory[key]?.valid).map(key => `${key}_memory_unavailable`),
    ...(!report.events ? ['event_history_unavailable'] : []),
    ...(origin && !origin.opcode_matches_memory ? [origin.source.endsWith('_syscall') ? 'syscall_instruction_opcode_not_verified' : 'break_instruction_opcode_not_verified'] : []),
    ...(report.cpu === 'iop' ? ['iop_module_identity_unavailable'] : []),
  ];
  return { ...report, context, observation: report.cpu === 'ee' ? 'configured_ee_exception' as const : 'configured_iop_exception' as const,
    instruction_evidence: instructionEvidence,
    pc_semantics: report.cpu === 'ee' ? 'cpuException_entry_PC_not_independently_verified_faulting_instruction' : 'psxException_entry_PC_not_independently_verified_faulting_instruction',
    branch_delay_semantics: report.cpu === 'ee' ? 'cpuException_bd_argument' : 'psxException_bd_argument',
    complete: partial.length === 0, partial_reasons: partial };
}
