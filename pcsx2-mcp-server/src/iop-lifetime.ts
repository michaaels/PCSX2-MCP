import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DebugServerClient } from './debug-server-client.js';
import { address } from './symbols.js';

const count = z.number().int().nonnegative().safe();
export const lifetimeResponse = z.object({ ok: z.literal(true), session: count, execution_epoch: count, iop_reset_epoch: count,
  iop_lifetime_epoch: count, scope: z.literal('observed_boundaries_only'), elf: z.string(), elf_crc: address,
  list_address: address, history_truncated: z.boolean(), events: z.array(z.object({ epoch: count.positive(), timestamp_ms: count,
    kind: z.enum(['server_start', 'vm_reset', 'cpu_reset', 'load_object_call', 'register_module_call', 'release_module_call',
      'savestate_load_attempt', 'sif_reset_packet', 'loadcore_locator_changed', 'debugger_mutation', 'module_reboot_call', 'module_service_call']), address })).max(64),
}).superRefine((s, ctx) => {
  if (!s.events.length || s.events.at(-1)!.epoch !== s.iop_lifetime_epoch ||
      s.events.some((e, i) => i > 0 && e.epoch !== s.events[i - 1].epoch + 1) ||
      (s.history_truncated && s.events.length !== 64)) ctx.addIssue({ code: 'custom', message: 'Inconsistent IOP lifetime history' });
});
export async function readIopLifetime(client: DebugServerClient, signal?: AbortSignal) {
  return client.withExclusiveSession(async () => {
    signal?.throwIfAborted(); const caps = await client.getCapabilities();
    if (!caps.features.includes('iop_lifetime') || caps.process_id === undefined) throw new Error('Rebuild PCSX2: iop_lifetime and process identity required');
    const result = await client.iopLifetime(); signal?.throwIfAborted();
    if (result.session !== caps.session || result.execution_epoch !== caps.execution_epoch || result.elf !== caps.elf ||
        result.elf_crc !== caps.elf_crc || result.iop_lifetime_epoch < caps.iop_lifetime_epoch!) throw new Error('IOP lifetime session changed');
    return { ...result, process_id: caps.process_id, module_generation: null, interpretation:
      'Conservative invalidation boundaries only; this epoch alone is not a module generation or binding. Register/release, modload and restore entries are call/attempt observations. A standard reset-shaped SIF1 packet proves transport observation, not handler completion. Explicit binding tools additionally require observed registration and fresh artifact/image checks; custom/direct paths remain partial.' };
  });
}
export function registerIopLifetimeTools(server: McpServer, getClient: () => DebugServerClient | null) {
  server.tool('pcsx2_iop_lifetime', 'Read the current conservative IOP lifetime epoch and last 64 observed boundaries without pausing/resuming or writing. Distinguishes CPU reset from transported standard SIF software-reset packet, loader/register/release calls, restore attempts and debugger writes. Module image/load requests guard this epoch; it is not a per-module generation or reusable binding. Custom/direct loader/reset coverage remains partial.', {}, async (_, extra) => {
    try {
      const client = getClient(); if (!client?.isConnected()) throw new Error('Connect to DebugServer first');
      return { content: [{ type: 'text' as const, text: JSON.stringify(await readIopLifetime(client, extra.signal), null, 2) }] };
    } catch (error) { return { content: [{ type: 'text' as const, text: String(error) }], isError: true }; }
  });
}
