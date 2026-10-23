import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DebugServerClient } from './debug-server-client.js';
import { irxFields, inspectRuntimeIrx } from './irx-tools.js';
import { inspectIrx } from './irx.js';
import { address } from './symbols.js';
import { watchId } from './exceptions.js';
import { SourceResolver } from './source-debug.js';

const createFields = { ...irxFields, load_watch_id: watchId, ttl_ms: z.number().int().min(100).max(300000).default(60000) };
const createOptions = z.object(createFields);
type Proof = Awaited<ReturnType<typeof inspectRuntimeIrx>>;
type Binding = { id: string; deadline: number; proof: Proof; status: 'retained' | 'invalidated'; reason: string };
const sameAffinity = (a: Proof['runtime'], b: { process_id?: number; session: number; execution_epoch?: number; iop_reset_epoch?: number; elf: string; elf_crc: string }) =>
  a.process_id === b.process_id && a.session === b.session && a.execution_epoch === b.execution_epoch && a.iop_reset_epoch === b.iop_reset_epoch &&
  a.elf === b.elf && a.elf_crc === b.elf_crc;

// Entries retain artifact/observation evidence, never a cached source mapping or
// permission to skip runtime validation. No guest execution or broad cleanup.
export class IopBindings {
  private entries = new Map<string, Binding>();
  constructor(private now = () => performance.now()) {}
  private summary(b: Binding) {
    return { binding_id: b.id, status: this.now() >= b.deadline ? 'expired' : b.status,
      reason: b.reason, remaining_ms: Math.max(0, Math.floor(b.deadline - this.now())),
      artifact: { ...b.proof.artifact }, process_id: b.proof.runtime.process_id, session: b.proof.runtime.session,
      module_record: b.proof.runtime.module.record_address, observed_generation: { ...b.proof.runtime.module.observed_generation! },
      origin: { watch_id: b.proof.load_provenance?.watch_id, file_sha256: b.proof.evidence.original_loaded_file_sha256,
        revision: b.proof.runtime.revision, scope: 'historical_verified_load_at_binding_creation' },
      current_validity: 'requires_fresh_paused_revalidation' };
  }
  list() { return { scope: 'this_mcp_process_only', bindings: [...this.entries.values()].map(b => this.summary(b)) }; }
  drop(id: string) { watchId.parse(id); if (!this.entries.delete(id)) throw new Error('Unknown IOP binding ID'); return { binding_id: id, removed: true }; }
  async create(client: DebugServerClient, input: z.input<typeof createOptions>, signal?: AbortSignal) {
    const options = createOptions.parse(input); signal?.throwIfAborted();
    const caps = await client.getCapabilities();
    if (!caps.features.includes('iop_module_generations')) throw new Error('Rebuild PCSX2: iop_module_generations required');
    const proof = await inspectRuntimeIrx(client, options, false, signal);
    if (!proof.runtime.module.observed_generation || !proof.load_provenance) throw new Error('A verified current observed registration and load receipt are required');
    signal?.throwIfAborted();
    for (const [id, b] of this.entries) if (this.now() >= b.deadline) this.entries.delete(id);
    if (this.entries.size >= 16) throw new Error('IOP binding capacity reached; drop a selected entry');
    const b: Binding = { id: randomUUID().replaceAll('-', ''), deadline: this.now() + options.ttl_ms, proof, status: 'retained', reason: '' };
    this.entries.set(b.id, b); return this.summary(b);
  }
  async inspect(client: DebugServerClient, id: string, addresses?: string[], signal?: AbortSignal, resolver = new SourceResolver()) {
    watchId.parse(id); if (addresses) z.array(address).min(1).max(64).parse(addresses);
    const b = this.entries.get(id); if (!b) throw new Error('Unknown IOP binding ID');
    if (this.now() >= b.deadline || b.status !== 'retained') throw new Error('IOP binding expired or invalidated');
    signal?.throwIfAborted();
    // A premature query while running is retryable; it does not consume the ID.
    if (!(await client.getStatus()).paused) throw new Error('Pause the VM before revalidating the IOP binding');
    try {
      const caps = await client.getCapabilities();
      if (!caps.features.includes('iop_module_generations') || !sameAffinity(b.proof.runtime, caps)) throw new Error('IOP binding VM/process identity changed');
      const file = await inspectIrx(b.proof.artifact.irx);
      if (file.sha256 !== b.proof.artifact.sha256 || file.file_version !== b.proof.artifact.file_version) throw new Error('IOP binding artifact changed');
      const proof = await inspectRuntimeIrx(client, { irx: file.irx, expected_sha256: file.sha256,
        module_record: b.proof.runtime.module.record_address, expected_registration_sequence: b.proof.runtime.module.observed_generation!.sequence,
        expected_registration_namespace: b.proof.runtime.module.observed_generation!.namespace,
        addresses }, true, signal, resolver);
      const after = await inspectIrx(file.irx);
      if (!sameAffinity(b.proof.runtime, proof.runtime) || after.sha256 !== file.sha256 || after.file_version !== file.file_version ||
          JSON.stringify(proof.runtime.module.observed_generation) !== JSON.stringify(b.proof.runtime.module.observed_generation))
        throw new Error('IOP binding changed during revalidation');
      signal?.throwIfAborted();
      if (this.entries.get(id) !== b || this.now() >= b.deadline || b.status !== 'retained') throw new Error('IOP binding released/expired during lookup');
      return { ...proof, binding: this.summary(b), interpretation:
        'Fresh paused artifact/image/source verification with the retained observed-registration token. Origin file SHA is historical evidence from binding creation, not a new full-file load claim. Tracking covers observed import paths only; custom/direct mutation is not universally excluded.' };
    } catch (error) {
      if (!signal?.aborted) { b.status = 'invalidated'; b.reason = String(error).slice(0, 512); }
      throw error;
    }
  }
}
export function registerIopBindingTools(server: McpServer, getClient: () => DebugServerClient | null) {
  const registry = new IopBindings();
  async function report(operation: () => Promise<unknown> | unknown) {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(), null, 2) }] };
    } catch (error) { return { content: [{ type: 'text' as const, text: String(error) }], isError: true }; }
  }
  const run = (operation: (client: DebugServerClient) => Promise<unknown>) => report(() => {
    const client = getClient(); if (!client?.isConnected()) throw new Error('Connect to DebugServer first'); return operation(client);
  });
  server.tool('pcsx2_iop_binding_create', 'Retain a selected IRX after full HostFs load-receipt verification at its first guarded pause and an observed native registration. Maximum 16 entries, wall TTL <=5 min, owned IDs in this MCP process only. Does not resume or install breakpoints. All later use revalidates file/runtime identity and code; observed-import coverage is partial.', createFields,
    (options, extra) => run(client => registry.create(client, options, extra.signal)));
  server.tool('pcsx2_iop_binding_source', 'At an already paused VM, freshly verify the retained artifact and observed registration, then resolve IOP source. Reusable between pauses only while all guards pass; reload/reboot/restore/mutations revoke native tracking. Source results are never cached. Origin file SHA stays historical; direct/custom loader paths remain outside the observed contract.',
    { binding_id: watchId, addresses: z.array(address).min(1).max(64).optional() },
    ({ binding_id, addresses }, extra) => run(client => registry.inspect(client, binding_id, addresses, extra.signal)));
  server.tool('pcsx2_iop_binding_list', 'List retained IOP artifact bindings and historical origin, expiry and last invalidation. Listing does not establish current validity or read guest memory.', {}, () => report(() => registry.list()));
  server.tool('pcsx2_iop_binding_drop', 'Remove only the selected retained IOP binding from this MCP process without changing the guest or breakpoints.',
    { binding_id: watchId }, ({ binding_id }) => report(() => registry.drop(binding_id)));
}
