import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DebugServerClient } from './debug-server-client.js';
import { SourceResolver, sourceOptions } from './source-debug.js';

export function registerSourceTools(server: McpServer, getClient: () => DebugServerClient | null) {
  async function run(operation: (resolver: SourceResolver) => Promise<unknown>) {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(new SourceResolver()), null, 2) }] }; }
    catch (error) { return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }], isError: true }; }
  }
  server.tool('pcsx2_source_locations', 'Resolve 1–64 hexadecimal linked addresses to source file/line, demangled function and inline frames from a local ELF32 MIPS debug executable. Works offline. Requires GNU/LLVM addr2line (Windows can fall back to WSL). Reports unknowns for stripped ELFs or addresses outside executable segments. No source files are opened, no VM changes, no address rebasing or locals.',
    sourceOptions.shape, (options, extra) => run(resolver => resolver.resolve(options, extra.signal)));
  server.tool('pcsx2_source_pc', 'Resolve a snapshot of the current EE program counter against the running ELF on disk. Checks PCSX2 CRC and VM identity; returns SHA256 of the file. Does not pause the VM. Requires DebugServer and an unstripped debug ELF at its loaded path, plus GNU/LLVM addr2line. CRC is not a cryptographic proof of the loaded image. IOP/module source lookup uses pcsx2_source_locations with an explicit ELF/address instead.',
    {}, (_options, extra) => run(async resolver => {
      const client = getClient();
      if (!client?.isConnected()) throw new Error('Connect to DebugServer first');
      return resolver.currentPc(client, extra.signal);
    }));
}
