import { z } from 'zod';

const count = z.number().int().nonnegative().safe();
const signed = z.number().int().min(-2147483648).max(2147483647);
const hex = z.string().regex(/^0x[\da-f]{8}$/);
export const sifIdentity = z.object({ process_id: count.positive(), session: count,
  execution_epoch: count, iop_reset_epoch: count, iop_lifetime_epoch: count, elf: z.string(), elf_crc: hex });
export type SifIdentity = z.infer<typeof sifIdentity>;
const ee = z.object({ chcr: hex, madr: hex, qwc: hex, tadr: hex });
const iop = z.object({ chcr: hex, madr: hex, bcr: hex, tadr: hex });
const fifo = z.object({ capacity: signed, words: signed, head: signed, tail: signed });
const write = z.object({ sequence: count.positive(), session: count, execution_epoch: count, iop_reset_epoch: count,
  iop_lifetime_epoch: count, address: hex, value: hex, bits: z.union([z.literal(16), z.literal(32)]),
  word_before: hex, word_after: hex, raw_iop_pc: hex, iop_cycles: hex });
export const sifResponse = sifIdentity.extend({ ok: z.literal(true), paused: z.literal(true),
  sample: z.object({ ee_pc: hex, ee_cycles: hex, iop_pc: hex, iop_cycles: hex }),
  sbus: z.object({ mscom: hex, smcom: hex, msflg: hex, smflg: hex, f240: hex, ee_intc_stat: hex,
    ee_intc_mask: hex, ee_dmac_stat: hex, iop_ireg: hex, iop_imask: hex, iop_ictrl: hex }),
  channels: z.array(z.object({ sif: z.number().int().min(0).max(2), ee, iop_backing: iop,
    backend: z.object({ ee_busy: z.boolean(), ee_end: z.boolean(), iop_busy: z.boolean(), iop_end: z.boolean(),
      iop_counter: signed, fifo_words: signed, fifo_read_pos: signed, fifo_write_pos: signed }) })).length(3),
  pgif: z.object({ ctrl_backing: hex, stat_backing: hex, data_fifo: fifo, command_fifo: fifo,
    linked_list_active: z.boolean(), to_gpu_active: z.boolean(), to_iop_active: z.boolean() }),
  writes: z.object({ capacity: z.literal(64), observed: count, dropped: count, entries: z.array(write).max(64) }),
}).superRefine((r, ctx) => {
  const entries = r.writes.entries;
  if (r.channels.some((c, i) => c.sif !== i) || r.writes.observed !== r.writes.dropped + entries.length ||
      entries.length !== Math.min(r.writes.observed, 64) || entries.some((w, i) => w.sequence !== r.writes.dropped + i + 1 ||
        w.session !== r.session || w.execution_epoch !== r.execution_epoch || w.iop_reset_epoch > r.iop_reset_epoch ||
        w.iop_lifetime_epoch > r.iop_lifetime_epoch || Number(w.address) < 0x1f8010a0 || Number(w.address) >= 0x1f8010b0 ||
        Number(w.address) % (w.bits / 8) !== 0 || w.bits === 16 && Number(w.value) > 0xffff))
    ctx.addIssue({ code: 'custom', message: 'Inconsistent SIF channel/write history identity, sequence or bounds' });
});

export function parseSifSnapshot(value: unknown, expected: SifIdentity) {
  const parsed = sifResponse.parse(value);
  for (const key of Object.keys(sifIdentity.shape) as (keyof SifIdentity)[])
    if (parsed[key] !== expected[key]) throw new Error('SIF snapshot VM/ELF/IOP identity mismatch');
  return parsed;
}

export function describeSifSnapshot(raw: z.infer<typeof sifResponse>) {
  const fifoConsistent = (f: z.infer<typeof fifo>) => f.capacity > 0 && f.words >= 0 && f.words <= f.capacity &&
    f.head >= 0 && f.head < f.capacity && f.tail >= 0 && f.tail < f.capacity;
  return { ...raw, interpretation: {
    source: 'paused_CPU_thread_backing_registers_and_backend_fields_no_MMIO_handlers',
    elf_identity: 'native_session_affinity_not_local_file_SHA_or_IOP_module_identity',
    writer_pc: 'raw_IOP_context_not_verified_writer_instruction',
    history_scope: 'PGIF_DMA_16_32_bit_dispatch_only_while_server_active_since_start_VM_reset_or_restore_attempt',
    cpu_cycles: 'independent_wrapping_32_bit_counters_not_a_global_clock',
    causality: 'not_established', physical_ps2_validation: 'not_performed',
  }, decoded_channels: raw.channels.map(c => ({ sif: c.sif,
    ee_direction_bit: Number(c.ee.chcr) & 1, ee_start_bit: Boolean(Number(c.ee.chcr) & 0x100),
    iop_direction_bit: Number(c.iop_backing.chcr) & 1, iop_start_bit: Boolean(Number(c.iop_backing.chcr) & 0x01000000),
    iop_block_size_field: Number(c.iop_backing.bcr) & 0xffff, iop_block_count_field: Number(c.iop_backing.bcr) >>> 16,
    backend_fifo_consistent: c.backend.fifo_words >= 0 && c.backend.fifo_words <= 128 && c.backend.fifo_read_pos >= 0 &&
      c.backend.fifo_read_pos < 128 && c.backend.fifo_write_pos >= 0 && c.backend.fifo_write_pos < 128 })),
  pgif_fifo_consistency: { data: fifoConsistent(raw.pgif.data_fifo), command: fifoConsistent(raw.pgif.command_fifo) },
  write_comparisons: raw.writes.entries.map(w => {
    const shift = (Number(w.address) & 2) * 8, mask = w.bits === 16 ? (0xffff << shift) >>> 0 : 0xffffffff;
    const expected = w.bits === 32 ? Number(w.value) : ((Number(w.word_before) & ~mask) | (Number(w.value) << shift)) >>> 0;
    return { sequence: w.sequence, simple_merge_word: '0x'+expected.toString(16).padStart(8, '0'),
      matches_simple_merge: expected === Number(w.word_after),
      meaning: 'backing_word_comparison_only_not_general_MMIO_acceptance_or_transfer_completion' };
  }) };
}
