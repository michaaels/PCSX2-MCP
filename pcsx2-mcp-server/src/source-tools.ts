import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DebugServerClient } from './debug-server-client.js';
import { SourceResolver, sourceOptions } from './source-debug.js';
import { SourceLineResolver, lineOptions } from './source-lines.js';
import { z } from 'zod';

export function registerSourceTools(server: McpServer, getClient: () => DebugServerClient | null) {
  async function run(operation: () => Promise<unknown>) {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(), null, 2) }] }; }
    catch (error) { return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && 'cleanup' in error ? { cleanup: error.cleanup } : {}) }) }], isError: true }; }
  }
  server.tool('pcsx2_source_addresses', 'Resolve an exact file/line to all aligned executable statement addresses in a local ELF (up to 64). Offline; optional pinned Python/pyelftools backend required. Explicit from=DWARF/to=local path mappings, or a unique relative filename. Rejects ambiguous files; never moves to another line. No source files are opened and no VM changes.',
    lineOptions.shape, (options, extra) => run(() => new SourceLineResolver().resolve(options, extra.signal)));
  server.tool('pcsx2_breakpoint_source', 'Install an owned group of non-temporary EE breakpoints at every exact-line statement address. Requires paused VM, matching local ELF/path/CRC, and updated native source_breakpoints capability. Does not resume. Rejects existing breakpoints without changing them; returns group_id for removal. No source stepping or locals.',
    lineOptions.shape, (options, extra) => run(async () => {
      const client = getClient();
      if (!client?.isConnected()) throw new Error('Connect to DebugServer first');
      return new SourceLineResolver().install(client, options, extra.signal);
    }));
  server.tool('pcsx2_remove_source_breakpoints', 'Remove a source breakpoint group by group_id while paused. Native ownership and VM/ELF identity checks preserve changed/replaced breakpoints. Reports preserved addresses as an incomplete cleanup; do not substitute clear-all-breakpoints.',
    { group_id: z.string().regex(/^[\da-f]{32}$/) }, ({ group_id }) => run(async () => {
      const client = getClient();
      if (!client?.isConnected()) throw new Error('Connect to DebugServer first');
      const result = await client.removeSourceBreakpoints(group_id);
      if (!result.complete) throw Object.assign(new Error('Some source breakpoints changed ownership and were preserved'), { cleanup: result });
      return result;
    }));
  server.tool('pcsx2_source_locations', 'Resolve 1–64 hexadecimal linked addresses to source file/line, demangled function and inline frames from a local ELF32 MIPS debug executable. Works offline. Requires GNU/LLVM addr2line (Windows can fall back to WSL). Reports unknowns for stripped ELFs or addresses outside executable segments. No source files are opened, no VM changes, no address rebasing or locals.',
    sourceOptions.shape, (options, extra) => run(() => new SourceResolver().resolve(options, extra.signal)));
  server.tool('pcsx2_source_pc', 'Resolve a snapshot of the current EE program counter against the running ELF on disk. Checks PCSX2 CRC and VM identity; returns SHA256 of the file. Does not pause the VM. Requires DebugServer and an unstripped debug ELF at its loaded path, plus GNU/LLVM addr2line. CRC is not a cryptographic proof of the loaded image. IOP/module source lookup uses pcsx2_source_locations with an explicit ELF/address instead.',
    {}, (_options, extra) => run(async () => {
      const client = getClient();
      if (!client?.isConnected()) throw new Error('Connect to DebugServer first');
      return new SourceResolver().currentPc(client, extra.signal);
    }));
}
