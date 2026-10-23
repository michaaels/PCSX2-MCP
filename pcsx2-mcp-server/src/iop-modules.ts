import { z } from 'zod';
import { address } from './symbols.js';

const counter = z.number().int().nonnegative().safe();
const word = z.number().int().min(0).max(0xffffffff);
export const observedGeneration = z.object({ scope: z.literal('observed_loadcore_registration'), sequence: counter.positive(),
  namespace: z.string().min(1).max(128).regex(/^\d+:\d+:\d+$/),
  registration_epoch: counter.positive(), module_id: z.number().int().min(0).max(65535) });
const runtimeModule = z.object({ record_address: address, next_address: address, name_address: address,
  module_id: z.number().int().min(0).max(65535).optional(), observed_generation: observedGeneration.nullable().optional(),
  name: z.string().regex(/^[\x20-\x7e]{0,127}$/).nullable(), version: z.number().int().min(0).max(65535),
  entry: address, gp: address, text_address: address, text_size: word, data_size: word, bss_size: word });
const snapshot = z.object({ ok: z.literal(true), cpu: z.literal('iop'), snapshot_id: counter, timestamp_ms: counter,
  session: counter, execution_epoch: counter, iop_reset_epoch: counter, iop_reset_scope: z.literal('cpu_reset_only'), revision: counter,
  iop_lifetime_epoch: counter.optional(),
  elf: z.string(), elf_crc: address, elf_role: z.literal('ee_boot_affinity_only'), scope: z.literal('paused_runtime_observation_only'),
  source: z.literal('pcsx2_detected_loadcore_list'), root_discovery_sequence: counter, list_address: address, head_address: address,
  status: z.enum(['observed', 'unavailable']), reason: z.string().min(1).max(128).nullable(), modules: z.array(runtimeModule).max(256) });
const canonical = (value: number, length: number) => (value & 3) === 0 && value >= 0 && value + length <= 0x200000;
function nameAddressAllowed(value: number) {
  if (value < 0x200000) return true;
  const p = value & 0x1fffffff;
  return p >= 0x1fc00000 && (value < 0x20000000 || (value >= 0x9fc00000 && value < 0xa0000000) || (value >= 0xbfc00000 && value < 0xc0000000));
}
export function parseIopModuleSnapshot(value: unknown) {
  const s = snapshot.parse(value);
  if (s.status === 'unavailable') {
    if (!s.reason || s.modules.length !== 0) throw new Error('Unavailable IOP list must not supply module identities');
    return s;
  }
  if (s.reason !== null || !Number(s.list_address) || !canonical(Number(s.list_address), 4) || s.root_discovery_sequence === 0 ||
      Number(s.head_address) !== Number(s.modules[0]?.record_address ?? '0')) throw new Error('Invalid observed IOP list root');
  const seen = new Set<string>();
  for (let i = 0; i < s.modules.length; i++) {
    const m = s.modules[i];
    if (!Number(m.record_address) || !canonical(Number(m.record_address), 40) || seen.has(m.record_address) ||
        m.next_address !== (s.modules[i + 1]?.record_address ?? '0x00000000') ||
        (m.name === null) !== (Number(m.name_address) === 0) || !nameAddressAllowed(Number(m.name_address)))
      throw new Error('Invalid IOP module record chain/name');
    seen.add(m.record_address);
    if (m.observed_generation && (m.module_id !== m.observed_generation.module_id || s.iop_lifetime_epoch === undefined ||
        m.observed_generation.registration_epoch > s.iop_lifetime_epoch)) throw new Error('Invalid observed IOP registration identity');
  }
  return s;
}
export function parseIopModuleImage(value: unknown) {
  const base = parseIopModuleSnapshot(value);
  const extra = z.object({ image_record: address, sample_pc: address, module_image: z.object({
    address, length: z.number().int().min(1).max(256 * 1024), valid: z.boolean(),
    hex: z.string().regex(/^(?:[\da-f]{2})+$/).max(512 * 1024).optional(), reason: z.string().optional(),
  }) }).parse(value);
  const module = base.modules.find(m => m.record_address === extra.image_record), image = extra.module_image;
  if (base.status !== 'observed' || !module || !image.valid || image.hex?.length !== image.length * 2 ||
      module.text_address !== image.address || image.length !== module.text_size + module.data_size ||
      !canonical(Number(image.address), image.length + module.bss_size)) throw new Error('Invalid or unavailable IOP module image');
  for (const other of base.modules) {
    if (other === module) continue;
    const start = Number(other.text_address), end = start + other.text_size + other.data_size + other.bss_size;
    if (start < Number(image.address) + image.length + module.bss_size && end > Number(image.address))
      throw new Error('IOP module image overlaps another observed module');
  }
  return { ...base, ...extra, module };
}
export function resolveIopModule(s: ReturnType<typeof parseIopModuleSnapshot>, input: string) {
  const pc = address.parse(input), value = Number(pc);
  const identity = { address: pc, snapshot_id: s.snapshot_id, artifact_identity: null, source_mapping: null };
  if (value >= 0x200000) return { ...identity, status: 'excluded_address' as const, reason: 'canonical_iop_ram_only' };
  if (s.status === 'unavailable') return { ...identity, status: 'unavailable' as const, reason: s.reason };
  const candidates = s.modules.flatMap(module => {
    const base = Number(module.text_address), total = module.text_size + module.data_size + module.bss_size;
    if ((base & 3) !== 0 || base + total > 0x200000) return [];
    const offset = value - base;
    if (offset < 0 || offset >= total) return [];
    const segment = offset < module.text_size ? 'text' as const : offset < module.text_size + module.data_size ? 'data' as const : 'bss' as const;
    const segmentStart = segment === 'text' ? 0 : segment === 'data' ? module.text_size : module.text_size + module.data_size;
    return [{ module, segment, offset_from_text: '0x' + offset.toString(16).padStart(8, '0'), segment_offset: '0x' + (offset - segmentStart).toString(16).padStart(8, '0') }];
  });
  if (candidates.length === 1) return { ...identity, status: 'matched_runtime_range' as const, ...candidates[0] };
  if (candidates.length > 1) return { ...identity, status: 'ambiguous' as const, candidates };
  return { ...identity, status: 'unmapped' as const, reason: 'no_observed_canonical_module_range' };
}
