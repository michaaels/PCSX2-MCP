import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DebugServerClient } from './debug-server-client.js';
import { address, cpu, symbolOptions } from './symbols.js';
import { ScenarioRunner, scenarioSchema } from './scenario.js';

const text = (value: unknown) => ({ type: 'text' as const, text: JSON.stringify(value, null, 2) });

export function registerWorkflowTools(server: McpServer, getClient: () => DebugServerClient | null) {
  const runner = new ScenarioRunner();
  async function run(operation: (client: DebugServerClient) => Promise<any>) {
    try {
      const client = getClient();
      if (!client?.isConnected()) throw new Error('Connect to the updated DebugServer first');
      return await operation(client);
    } catch (error) { return { content: [text({ error: error instanceof Error ? error.message : String(error) })], isError: true }; }
  }
  server.resource('debug_workflows', 'ps2://debug_workflows', async () => ({
    contents: [{ uri: 'ps2://debug_workflows', mimeType: 'text/plain', text:
      'Symbol tools read PCSX2\'s imported/analysed symbol database, with optional source filenames. They do not parse DWARF or provide source lines/locals.\n' +
      'Lookup names are case-sensitive substrings unless exact=true. Paginate with next_offset; database imports may change between calls.\n' +
      'Run scenarios only after the ELF is booted. The runner pauses the VM, checks its identity between steps, and leaves it paused.\n' +
      'Scenarios support frames, input, assertions (memory/expression/new logs/controller), run-to-symbol/address, screenshots and contexts.\n' +
      'Provide output_directory: a unique run folder contains the recipe and JSON report, PNGs and a failure context when available.\n' +
      'The connection is exclusive during a scenario. External UI/clients can still interfere. No arbitrary scripts, commands, memory writes or build steps are executed.\n' +
      'Screenshot hash assertions compare exact encoded PNGs; they are not visual similarity checks.\n',
    }],
  }));
  server.tool('pcsx2_import_symbols', 'Request asynchronous import of the current EE ELF symbols without opening the graphical debugger or changing persistent settings. Uses configured extra symbol files, skips function scanning/hashing. Success means requested; query until expected symbols appear. Repeat after ELF reload if automatic import is disabled. A stripped ELF may provide no names.',
    {}, () => run(async client => ({ content: [text(await client.importSymbols())] })));
  server.tool('pcsx2_lookup_symbols', 'Search the running EE/IOP symbol database for functions/global variables imported or analysed by PCSX2. Returns addresses, sizes and source filename when available. Case-sensitive substring or exact match; offset/limit pagination. No DWARF line or local-variable support.',
    symbolOptions.shape, options => run(async client => ({ content: [text(await client.lookupSymbols(options))] })));
  server.tool('pcsx2_resolve_address', 'Find up to 100 function/global symbols that contain a CPU address, including offsets and optional source filenames. Zero-size symbols match only their starting address; no guessed nearest symbol.',
    { address, cpu }, ({ address, cpu }) => run(async client => ({ content: [text(await client.resolveAddress(address, cpu))] })));
  server.tool('pcsx2_breakpoint_symbol', 'Set a breakpoint using an exact function name in the native symbol database. Resolves and installs on the CPU thread; rejects missing/ambiguous names. Like pcsx2_set_breakpoint, an existing breakpoint may be enabled. Does not resume execution.',
    { name: z.string().min(1).max(256), cpu, temporary: z.boolean().default(false) },
    ({ name, cpu, temporary }) => run(async client => ({ content: [text(await client.setSymbolBreakpoint(name, cpu, temporary))] })));
  server.tool('pcsx2_run_scenario', 'Run a bounded typed debug recipe against a booted ELF. Holds exclusive use of this MCP connection and leaves the VM paused. Stops on first failed assertion, saves report/PNGs and attempts a failure context. expected_elf_crc can guard the build. An in-flight native command/cleanup may outlast the deadline. No shell commands or arbitrary tool dispatch.',
    { scenario: scenarioSchema, output_directory: z.string().min(1), timeout_ms: z.number().int().min(1).max(45000).default(30000) },
    ({ scenario, output_directory, timeout_ms }, extra) => run(async client => {
      const report = await runner.run(client, scenario, output_directory, { timeoutMs: timeout_ms, signal: extra.signal });
      return { content: [text(report)], isError: !report.passed };
    }));
}
