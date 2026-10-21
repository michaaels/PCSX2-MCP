import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DebugServerClient } from './debug-server-client.js';
import { address } from './symbols.js';
import { resolveIopModule } from './iop-modules.js';

export async function readIopModules(client: DebugServerClient, input?: string, signal?: AbortSignal) {
  const target = input === undefined ? undefined : address.parse(input);
  return client.withExclusiveSession(async () => {
    signal?.throwIfAborted();
    const caps = await client.getCapabilities();
    if (!caps.features.includes('iop_module_snapshot') || caps.process_id === undefined || caps.execution_epoch === undefined ||
        caps.iop_reset_epoch === undefined || caps.iop_reset_scope !== 'cpu_reset_only') throw new Error('Rebuild PCSX2: iop_module_snapshot capability and CPU identity required');
    const result = await client.iopModuleSnapshot({ ...caps, process_id: caps.process_id, execution_epoch: caps.execution_epoch, iop_reset_epoch: caps.iop_reset_epoch });
    signal?.throwIfAborted();
    return { ...result, ...(target === undefined ? {} : { association: resolveIopModule(result, target) }),
      artifact_identity: null, source_mapping: null,
      interpretation: 'Observed runtime table and ranges only; no IRX file identity, load generation or source binding. EE ELF is boot affinity only.' };
  });
}
export function registerIopModuleTools(server: McpServer, getClient: () => DebugServerClient | null) {
  server.tool('pcsx2_iop_modules', 'Read a bounded native IOP loadcore module snapshot while VM is already paused; never pauses/resumes or writes. Includes name/version, entry/GP, text/data/BSS sizes and runtime record addresses. Optional address resolves canonical IOP RAM against observed ranges, with ambiguous/unmapped/unavailable states. Name/version and range membership do not prove a local IRX artifact, module load generation, source mapping or fault cause. EE ELF remains boot affinity only. Reset invalidates the native locator until loadcore is observed again; software reboot and savestate are not lifetime guards.',
    { address: address.optional() }, async ({ address: target }, extra) => {
      try {
        const client = getClient(); if (!client?.isConnected()) throw new Error('Connect to DebugServer first');
        return { content: [{ type: 'text' as const, text: JSON.stringify(await readIopModules(client, target, extra.signal), null, 2) }] };
      } catch (error) { return { content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error) }) }], isError: true }; }
    });
}
