import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DebugServerClient } from './debug-server-client.js';
import { collectOptions, correlateOptions, collectProjectDiagnostics, correlateProjectDiagnostics } from './project-diagnostics.js';

export function registerProjectDiagnosticTools(server: McpServer, getClient: () => DebugServerClient | null) {
  async function run(operation: () => Promise<unknown>) {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(), null, 2) }] }; }
    catch (error) { return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error instanceof Error ? error.message : 'Diagnostic operation failed' }) }], isError: true }; }
  }
  server.tool('pcsx2_diagnostics_collect', 'Collect bounded read-only native event history and strictly parsed SMS JFCLIENT console fields for a matching project manifest/ELF. Saves a sanitized, hashed local capture without raw console text, paths, URLs or credentials. Does not pause/resume. Historical entries have session scope, no per-entry ELF/epoch identity.',
    collectOptions.shape, (input, extra) => run(async () => {
      const client = getClient(); if (!client?.isConnected()) throw new Error('Connect to DebugServer first');
      return collectProjectDiagnostics(client, input, extra.signal);
    }));
  server.tool('pcsx2_diagnostics_correlate', 'Offline association of an explicit build/boot in bounded Bridge ps2.jsonl with an optional sanitized native capture. Verifies manifest/ELF SHA256 and CRC, rejects conflicting sequences/devices, and saves a hash-referenced report. Only reported session/sequence/event/level matches join; missing data and unbounded clock uncertainty stay explicit. No merged exact timeline, latency or root-cause claim.',
    correlateOptions.shape, (input, extra) => run(() => correlateProjectDiagnostics(input, extra.signal)));
}
