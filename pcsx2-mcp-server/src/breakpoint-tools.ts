import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DebugServerClient, type PointOptions } from './debug-server-client.js';
import { address, cpu } from './symbols.js';

const condition = z.string().max(4096).refine(value => Buffer.byteLength(value, 'utf8') <= 4096,
  'Condition exceeds 4096 UTF-8 bytes').optional().describe('Native CPU expression, e.g. v0 == 0x42. Invalid expressions are rejected before changing a point.');
const point = { address, cpu };
const watch = { ...point, end: address.optional().describe('Exclusive end; default start+4. Must be above start and fit in 32 bits.') };
const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
function optionsText(point: PointOptions) {
  if (!point.options_available) return '';
  return `${point.max_hits ? ` [max hits: ${point.max_hits}]` : ''}${point.instrumentation_enabled ? ` [log: ${point.log_format || 'native default'}; continue: ${point.continue_on_hit}]` : ''}`;
}

export function registerBreakpointTools(server: McpServer, getClient: () => DebugServerClient | null) {
  async function run(operation: (client: DebugServerClient) => Promise<string>) {
    try {
      const client = getClient();
      if (!client?.isConnected()) throw new Error('DebugServer not connected.');
      return text(await operation(client));
    } catch (error) { return { ...text('Error: ' + (error instanceof Error ? error.message : String(error))), isError: true }; }
  }
  const label = (value: string, target: 'ee' | 'iop') => target === 'iop' ? '[IOP] ' + value : value;
  function range(start: string, end?: string) {
    const first = parseInt(start.replace(/^0x/i, ''), 16), last = end ? parseInt(end.replace(/^0x/i, ''), 16) : first + 4;
    if (last <= first || last > 0xffffffff) throw new Error('Watchpoint end must be above start and fit in 32 bits');
    return end ?? '0x' + last.toString(16);
  }
  async function requireAtomicConditions(client: DebugServerClient, value?: string) {
    if (value && !(await client.getCapabilities()).features.includes('atomic_point_conditions'))
      throw new Error('Rebuild PCSX2: atomic_point_conditions required before setting a condition');
  }

  server.tool('pcsx2_set_breakpoint', 'Set an EE/IOP execution breakpoint with an optional native condition. Defaults to EE. On the updated native build, an invalid condition fails before inserting/editing a point or relinquishing source-group ownership.',
    { ...point, condition, description: z.string().optional(), temporary: z.boolean().default(false) },
    ({ address, cpu, condition, description, temporary }) => run(async client => {
      await requireAtomicConditions(client, condition);
      await client.setBreakpoint(address, { cpu, condition, description, temporary });
      return label(`Breakpoint set at ${address}${condition ? ` [condition: ${condition}]` : ''}`, cpu);
    }));
  server.tool('pcsx2_remove_breakpoint', 'Remove an execution breakpoint on the selected CPU (default EE). This explicit mutation can remove a user point; source-group cleanup uses its separate ownership API.', point,
    ({ address, cpu }) => run(async client => { await client.removeBreakpoint(address, cpu); return label(`Breakpoint removed at ${address}`, cpu); }));
  server.tool('pcsx2_list_breakpoints', 'List execution breakpoints and conditions for EE or IOP (default EE). Does not modify points.', { cpu },
    ({ cpu }) => run(async client => {
      const points = await client.listBreakpoints(cpu);
      if (!points.length) return label('No breakpoints set.', cpu);
      const lines = points.map(bp => `${bp.address} ${bp.enabled ? '✅' : '❌'}${bp.has_condition ? ` [cond: ${bp.condition}]` : ''}${bp.description ? ` — ${bp.description}` : ''}${bp.temporary ? ' (temp)' : ''}${optionsText(bp)}`);
      return label(`${points.length} breakpoint(s):\n${lines.join('\n')}`, cpu);
    }));
  server.tool('pcsx2_set_watchpoint', 'Set an EE/IOP memory watchpoint with native condition and break/log/both action (default EE/write/break). On the updated native build, invalid conditions fail before changing an existing watchpoint.',
    { ...watch, type: z.enum(['read', 'write', 'readwrite', 'onchange']).default('write'), action: z.enum(['break', 'log', 'both']).default('break'), condition, description: z.string().optional() },
    ({ address, end, cpu, type, action, condition, description }) => run(async client => {
      const last = range(address, end); await requireAtomicConditions(client, condition);
      await client.setMemcheck(address, last, { cpu, type, action, condition, description });
      return label(`Watchpoint (${type}/${action}) set at ${address}-${last}${condition ? ` [cond: ${condition}]` : ''}`, cpu);
    }));
  server.tool('pcsx2_remove_watchpoint', 'Remove an exact memory watchpoint range on EE or IOP (default EE, end=start+4).', watch,
    ({ address, end, cpu }) => run(async client => {
      const last = range(address, end); await client.removeMemcheck(address, last, cpu); return label(`Watchpoint removed at ${address}-${last}`, cpu);
    }));
  server.tool('pcsx2_list_watchpoints', 'List memory watchpoints and hit counts for EE or IOP (default EE). Does not modify points.', { cpu },
    ({ cpu }) => run(async client => {
      const points = await client.listMemchecks(cpu);
      if (!points.length) return label('No watchpoints set.', cpu);
      const lines = points.map(mc => `${mc.start}-${mc.end} | ${mc.hits} hits | last_PC=${mc.last_pc}${mc.has_condition ? ` [cond: ${mc.condition}]` : ''}${mc.description ? ` — ${mc.description}` : ''}${optionsText(mc)}`);
      return label(`${points.length} watchpoint(s):\n${lines.join('\n')}`, cpu);
    }));
}
