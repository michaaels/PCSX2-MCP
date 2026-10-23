import { z } from 'zod';
import { createHash } from 'node:crypto';
import { address } from './symbols.js';
import { watchId } from './exceptions.js';
import { parseIrx } from './irx.js';

const count = z.number().int().nonnegative().safe();
const pending = ['armed', 'file_reading', 'file_complete', 'buffer_observed'];
export const loadFields = { irx: z.string().min(1), expected_sha256: z.string().regex(/^[\da-fA-F]{64}$/).optional(),
  timeout_ms: z.number().int().min(100).max(300000).default(30000) };
export const loadOptions = z.object(loadFields);
export const loadState = z.object({ ok: z.literal(true), watch_id: watchId,
  state: z.enum(['armed', 'file_reading', 'file_complete', 'buffer_observed', 'registered', 'expired', 'cancelled',
    'vm_changed', 'cpu_reset', 'vm_stopped', 'debugger_mutation', 'savestate_load_attempt', 'ambiguous_file_open',
    'file_mode_or_size_mismatch', 'file_extent_changed', 'inconsistent_file_reads', 'incomplete_file_reads',
    'source_header_changed', 'unsupported_file_info_layout', 'registration_metadata_mismatch']),
  active: z.boolean(), session: count, execution_epoch: count, iop_reset_epoch: count, elf: z.string(), elf_crc: address,
  path: z.string().min(1).max(4096), expected_sha256: z.string().regex(/^[\da-f]{64}$/), size: count.min(64).max(1024 * 1024),
  covered_bytes: count, read_count: count, file_closed: z.boolean(), binding_available: z.boolean(), binding_reason: z.string(), binding_revision: count,
  buffer_address: address, file_info_address: address, module_record: address, loader_sample_pc: address,
  buffer_timestamp_ms: count, registration_timestamp_ms: count, file_info: z.array(address).length(9),
  source_bytes_base64: z.string().max(1398104).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).nullable(),
}).superRefine((s, ctx) => {
  if (s.active !== pending.includes(s.state) || s.covered_bytes > s.size || (s.binding_available && s.state !== 'registered') ||
      (s.source_bytes_base64 !== null) !== (s.state === 'registered') ||
      (s.state === 'registered' && (s.covered_bytes !== s.size || s.read_count === 0 || !s.file_closed)))
    ctx.addIssue({ code: 'custom', message: 'Inconsistent IOP load observation' });
});
export function decodeLoadReceipt(input: unknown) {
  const state = loadState.parse(input);
  if (state.state !== 'registered') throw new Error('IOP load not registered; no provenance receipt');
  const bytes = Buffer.from(state.source_bytes_base64!, 'base64');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== state.size || bytes.toString('base64') !== state.source_bytes_base64 || sha256 !== state.expected_sha256)
    throw new Error('Observed file/loader bytes do not match selected IRX SHA256');
  const irx = parseIrx(bytes), f = state.file_info.map(Number), base = f[3];
  if (irx.debugRelocationCount || f[0] !== 4 || f[1] !== irx.entry || f[2] !== irx.gp ||
      f[4] !== irx.textSize || f[5] !== irx.dataSize || f[6] !== irx.bssSize || f[7] !== irx.memSize || f[8] !== irx.modId ||
      base < 48 || base % 4 || base + irx.memSize > 0x200000 || Number(state.module_record) !== base - 48 ||
      Number(state.buffer_address) % 4 || Number(state.buffer_address) + state.size > 0x200000 ||
      Number(state.file_info_address) % 4 || Number(state.file_info_address) + 36 > 0x200000)
    throw new Error('IOP loader FileInfo/registration does not match captured IRX');
  const { source_bytes_base64: omitted, ...summary } = state;
  return { state, irx, summary: { ...summary, source: 'hostfs_full_read_loadcore_23_register_16', file_sha256: sha256,
    file_size: bytes.length, file_bytes_verified: true, filesystem_reads_verified: true, loader_buffer_verified: true } };
}
export function checkLoadAssociation(receipt: ReturnType<typeof decodeLoadReceipt>, candidate: ReturnType<typeof parseIrx>, current: {
  session: number; execution_epoch: number; iop_reset_epoch: number; revision: number; elf: string; elf_crc: string;
}, record: string) {
  const s = receipt.state;
  if (!s.binding_available || s.binding_revision !== current.revision || s.session !== current.session || s.execution_epoch !== current.execution_epoch ||
      s.iop_reset_epoch !== current.iop_reset_epoch || s.elf !== current.elf || s.elf_crc !== current.elf_crc || s.module_record !== record)
    throw new Error('IOP load receipt does not belong to this module/current guarded pause');
  const plan = (x: ReturnType<typeof parseIrx>) => x.relocationGroups.map(g => g.map(r => [r.offset, r.type]));
  if (!candidate.image.equals(receipt.irx.image) || !candidate.moduleInfo.equals(receipt.irx.moduleInfo) ||
      JSON.stringify(plan(candidate)) !== JSON.stringify(plan(receipt.irx)))
    throw new Error('IRX candidate does not match the complete captured load image/relocation plan');
}
