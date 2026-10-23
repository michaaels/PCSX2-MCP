import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DebugServerClient } from './debug-server-client.js';
import { address } from './symbols.js';
import { inspectIrx, verifyIrxImage } from './irx.js';
import { SourceResolver } from './source-debug.js';
import { watchId } from './exceptions.js';
import { decodeLoadReceipt, checkLoadAssociation } from './iop-load.js';

export const irxFields = { irx: z.string().min(1), module_record: address,
  expected_sha256: z.string().regex(/^[\da-fA-F]{64}$/).optional(), load_watch_id: watchId.optional() };
export const irxOptions = z.object({ ...irxFields, addresses: z.array(address).min(1).max(64).optional(),
  expected_registration_sequence: z.number().int().positive().safe().optional(), expected_registration_namespace: z.string().min(1).max(128).optional() });
export async function inspectRuntimeIrx(client: DebugServerClient, input: z.input<typeof irxOptions>,
  sources = false, signal?: AbortSignal, resolver = new SourceResolver()) {
  const options = irxOptions.parse(input);
  return client.withExclusiveSession(async () => {
    signal?.throwIfAborted(); const caps = await client.getCapabilities();
    if (!caps.features.includes('iop_module_image') || caps.process_id === undefined || caps.execution_epoch === undefined || caps.iop_reset_epoch === undefined)
      throw new Error('Rebuild PCSX2: iop_module_image and VM/IOP identities required');
    if (options.load_watch_id && !caps.features.includes('iop_load_provenance')) throw new Error('Rebuild PCSX2: iop_load_provenance required');
    if (options.expected_registration_sequence && !caps.features.includes('iop_module_generations')) throw new Error('Rebuild PCSX2: iop_module_generations required');
    const identity = { ...caps, process_id: caps.process_id, execution_epoch: caps.execution_epoch, iop_reset_epoch: caps.iop_reset_epoch };
    const table = await client.iopModuleSnapshot(identity);
    const observed = table.modules.find(m => m.record_address === options.module_record);
    if (table.status !== 'observed' || !observed) throw new Error('Module record not observed; choose from pcsx2_iop_modules');
    if (options.expected_registration_sequence !== undefined && observed.observed_generation?.sequence !== options.expected_registration_sequence)
      throw new Error('IOP observed registration generation changed or unavailable');
    if (options.expected_registration_namespace !== undefined && observed.observed_generation?.namespace !== options.expected_registration_namespace)
      throw new Error('IOP observed registration generation namespace changed');
    const irx = await inspectIrx(options.irx);
    if (options.expected_sha256 && options.expected_sha256.toLowerCase() !== irx.sha256) throw new Error('IRX SHA256 does not match expected_sha256');
    signal?.throwIfAborted();
    const expected = { ...identity, revision: table.revision, registration_sequence: options.expected_registration_sequence,
      registration_namespace: options.expected_registration_namespace ?? observed.observed_generation?.namespace };
    const before = await client.iopModuleImage(expected, options.module_record);
    const sameTable = (s: typeof before) => s.root_discovery_sequence === table.root_discovery_sequence && s.list_address === table.list_address &&
      JSON.stringify(s.module) === JSON.stringify(observed);
    if (!sameTable(before)) throw new Error('IOP module changed before verification');
    const verified = verifyIrxImage(irx, before.module, Buffer.from(before.module_image.hex!, 'hex'));
    const load = options.load_watch_id ? decodeLoadReceipt(await client.iopLoadWatchStatus(options.load_watch_id)) : null;
    if (load) checkLoadAssociation(load, irx, before, options.module_record);
    const addresses = options.addresses ?? [before.sample_pc], bias = Number(before.module.text_address);
    const eligible = addresses.filter(a => Number(a) % 4 === 0 && verified.eligible(Number(a) - bias));
    const located = sources && eligible.length ? await resolver.resolveIrx(irx.irx, irx.sha256,
      eligible.map(a => '0x' + (Number(a) - bias).toString(16).padStart(8, '0')), signal) : null;
    signal?.throwIfAborted();
    const after = await client.iopModuleImage(expected, options.module_record);
    const final = verifyIrxImage(irx, after.module, Buffer.from(after.module_image.hex!, 'hex'));
    const finalFile = await inspectIrx(irx.irx);
    if (load) {
      const afterLoad = decodeLoadReceipt(await client.iopLoadWatchStatus(options.load_watch_id!));
      checkLoadAssociation(afterLoad, irx, after, options.module_record);
      if (afterLoad.summary.file_sha256 !== load.summary.file_sha256 || afterLoad.state.buffer_timestamp_ms !== load.state.buffer_timestamp_ms ||
          afterLoad.state.registration_timestamp_ms !== load.state.registration_timestamp_ms) throw new Error('IOP load receipt changed during lookup');
    }
    if (!sameTable(after) || after.sample_pc !== before.sample_pc || final.normalized_readonly_sha256 !== verified.normalized_readonly_sha256 ||
        finalFile.sha256 !== irx.sha256 || finalFile.file_version !== irx.file_version) throw new Error('IOP module/file changed during verification/source lookup');
    signal?.throwIfAborted();
    const { eligible: predicate, ...evidence } = verified;
    return { ok: true, cpu: 'iop', scope: 'paused_revalidated_code_association',
      artifact: { irx: irx.irx, sha256: irx.sha256, file_version: irx.file_version, has_debug_lines: irx.has_debug_lines, debug_line_status: irx.debug_line_status },
      evidence: { ...evidence, original_loaded_file_sha256: load?.summary.file_sha256 ?? null },
      ...(load ? { load_provenance: load.summary, candidate_relationship: 'identical_complete_load_image_and_relocation_plan' } : {}),
      runtime: { process_id: caps.process_id, session: caps.session, execution_epoch: caps.execution_epoch,
        iop_lifetime_epoch: table.iop_lifetime_epoch,
        iop_reset_epoch: caps.iop_reset_epoch, revision: table.revision, elf: caps.elf, elf_crc: caps.elf_crc,
        elf_role: 'ee_boot_affinity_only', before_snapshot: before.snapshot_id, after_snapshot: after.snapshot_id, module: before.module },
      ...(sources ? { source_tool: located?.tool ?? null, locations: addresses.map(a => {
        const linked = Number(a) - bias, key = '0x' + linked.toString(16).padStart(8, '0');
        const match = located?.locations.find(l => l.address === key);
        return { runtime_address: a, linked_address: predicate(linked) ? key : null,
          ...(match ?? { resolved: false, frames: [], reason: 'outside_verified_executable_text_or_loader_table' }) };
      }) } : {}),
      interpretation: load ? 'Observed HostFs file bytes, loader input and registration match this module at the first guarded pause. The selected candidate has the same full load image/relocation plan; a debug companion can have a different file SHA. Module generation and import target semantics are not proven.' :
        'Selected local artifact hash and relocated immutable image match at this guarded pause. Writable data, import targets, original load-file identity and module generation are not proven. No reusable binding is retained.' };
  });
}
export function registerIrxTools(server: McpServer, getClient: () => DebugServerClient | null) {
  async function run(operation: (client: DebugServerClient) => Promise<unknown>) {
    try {
      const client = getClient(); if (!client?.isConnected()) throw new Error('Connect to DebugServer first');
      return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(client), null, 2) }] };
    } catch (error) { return { content: [{ type: 'text' as const, text: String(error) }], isError: true }; }
  }
  server.tool('pcsx2_iop_verify_irx', 'Validate a local 0xff80 IRX against one observed IOP module at an already paused VM. Reconstructs relocations and compares immutable sections twice, bounding known import/export linkage while checking export function pointers. Optional load_watch_id requires the full candidate load image/relocation plan to match observed HostFs/loader bytes at their first guarded pause, then reports the original file SHA. Without it, original file identity and writable initializers are unproven. No generation binding, pause/resume or guest writes.',
    irxFields, (options, extra) => run(client => inspectRuntimeIrx(client, options, false, extra.signal)));
  server.tool('pcsx2_iop_source', 'Resolve up to 64 runtime IOP addresses (default sampled IOP PC) through the selected IRX after relocated immutable-image verification. Optional load_watch_id also verifies full observed file/loader provenance at the first capture pause. Revalidates image, module, receipt, pause and file after lookup. Import/export tables and nonexecutable addresses stay unresolved. Missing DWARF is explicit. No breakpoints or reusable generation bindings; module lifetime guards remain separate.',
    { ...irxFields, addresses: irxOptions.shape.addresses },
    (options, extra) => run(client => inspectRuntimeIrx(client, options, true, extra.signal)));
}
