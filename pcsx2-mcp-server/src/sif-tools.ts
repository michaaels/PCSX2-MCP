import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DebugServerClient } from './debug-server-client.js';
import { sifIdentity, describeSifSnapshot } from './sif-state.js';

export async function readSifSnapshot(client: DebugServerClient, signal?: AbortSignal) {
  return client.withExclusiveSession(async () => {
    signal?.throwIfAborted(); const caps = await client.getCapabilities();
    if (!caps.features.includes('sif_snapshot')) throw new Error('Rebuild PCSX2: sif_snapshot required');
    const expected = sifIdentity.parse(caps), before = await client.getStatus();
    if (!before.paused) throw new Error('Pause the VM before reading SIF state');
    signal?.throwIfAborted(); const snapshot = await client.sifSnapshot(expected);
    const after = sifIdentity.parse(await client.getCapabilities()), status = await client.getStatus();
    for (const key of Object.keys(sifIdentity.shape) as (keyof typeof expected)[])
      if (expected[key] !== after[key]) throw new Error('SIF session/epoch changed during snapshot');
    if (!status.paused || before.pc !== status.pc || before.cycles !== status.cycles ||
        Number(snapshot.sample.ee_pc) !== Number(before.pc) || Number(snapshot.sample.ee_cycles) !== before.cycles)
      throw new Error('Paused CPU state changed during SIF snapshot');
    signal?.throwIfAborted(); return describeSifSnapshot(snapshot);
  });
}

export function registerSifTools(server: McpServer, getClient: () => DebugServerClient | null) {
  server.tool('pcsx2_sif_snapshot', 'Read paused SIF0/1/2 EE DMA, IOP backing registers, SBUS/interrupt bits, backend/PGIF FIFO counters and the last 64 observed PGIF DMA writes. Requires rebuilt native sif_snapshot support. Does not pause/resume, drain FIFO, call MMIO handlers or write guest state. History records actual 16/32-bit dispatch before/after words, with epoch/sequence and raw IOP PC (not proven writer instruction). Comparisons do not prove ACK, root cause, bus mode, audio quality or physical PS2 behavior.', {}, async (_, extra) => {
    try {
      const client = getClient(); if (!client?.isConnected()) throw new Error('Connect to DebugServer first');
      return { content: [{ type: 'text' as const, text: JSON.stringify(await readSifSnapshot(client, extra.signal), null, 2) }] };
    } catch (error) { return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'SIF snapshot failed' }], isError: true }; }
  });
}
