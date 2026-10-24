import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DebugServerClient } from './debug-server-client.js';
import { sifIdentity, type SifIdentity } from './sif-state.js';

const hex = z.string().regex(/^0x[\da-f]{8}$/);
export const instructionOptions = z.object({ cpu: z.enum(['ee', 'iop']).default('ee'),
  count: z.number().int().min(1).max(100).default(1),
  timeout_ms: z.number().int().min(10).max(5000).default(1000), show_registers: z.boolean().default(false) });
const response = sifIdentity.extend({ ok: z.literal(true), cpu: z.enum(['ee', 'iop']),
  old_pc: hex, new_pc: hex, disasm: z.string(), opcode: hex, paused: z.literal(true), cleanup_confirmed: z.literal(true) });

function assertIdentity(expected: SifIdentity, actual: SifIdentity, cpu: 'ee' | 'iop') {
  for (const key of ['process_id', 'session', 'execution_epoch', 'elf', 'elf_crc'] as const)
    if (expected[key] !== actual[key]) throw new Error('Instruction VM/ELF identity changed');
  if (cpu === 'iop' && (expected.iop_reset_epoch !== actual.iop_reset_epoch || expected.iop_lifetime_epoch !== actual.iop_lifetime_epoch))
    throw new Error('Instruction IOP identity changed');
}

export async function runInstructionSteps(client: DebugServerClient, input: unknown, over = false, signal?: AbortSignal) {
  const options = instructionOptions.parse(input);
  if (over && options.count !== 1) throw new Error('Step-over accepts exactly one call/instruction');
  return client.withExclusiveSession(async () => {
    const steps: z.infer<typeof response>[] = [], started = performance.now();
    let identity: SifIdentity | undefined;
    try {
      signal?.throwIfAborted(); const caps = await client.getCapabilities(); identity = sifIdentity.parse(caps);
      if (!caps.features.includes('bounded_instruction_step')) throw new Error('Rebuild PCSX2: bounded_instruction_step required');
      if (!(await client.getStatus()).paused) throw new Error('Pause the VM before instruction stepping');
      const registers = await client.readRegisters(options.cpu, 0); let pc = hex.parse(registers.pc);
      const deadline = performance.now() + options.timeout_ms;
      for (let i = 0; i < options.count; i++) {
        signal?.throwIfAborted(); const remaining = Math.ceil(deadline - performance.now());
        if (remaining < 10) throw new Error('Instruction sequence execution budget exhausted; no further instruction started');
        const expected = { ...identity, pc };
        const raw = over ? await client.stepOver(options.cpu, remaining, expected) : await client.step(options.cpu, remaining, expected);
        const result = response.parse(raw); assertIdentity(identity, result, options.cpu);
        if (result.cpu !== options.cpu || result.old_pc !== pc) throw new Error('Instruction CPU/PC result mismatch');
        steps.push(result); pc = result.new_pc;
        signal?.throwIfAborted(); const after = sifIdentity.parse(await client.getCapabilities()); assertIdentity(identity, after, options.cpu);
        if (!(await client.getStatus()).paused) throw new Error('VM resumed after instruction step');
      }
      const registersAfter = options.show_registers ? await client.readRegisters(options.cpu, 0) : undefined;
      if (registersAfter) {
        if (registersAfter.pc !== pc) throw new Error('CPU changed before register snapshot');
        assertIdentity(identity, sifIdentity.parse(await client.getCapabilities()), options.cpu);
        if (!(await client.getStatus()).paused) throw new Error('VM resumed before register snapshot');
      }
      signal?.throwIfAborted();
      return { completed: true, cpu: options.cpu, identity, count_requested: options.count, steps,
        elapsed_ms: performance.now() - started, execution_budget_ms: options.timeout_ms, registers: registersAfter };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('Instruction operation failed');
      throw Object.assign(failure, { partial: { cpu: options.cpu, identity, count_requested: options.count,
        steps, elapsed_ms: performance.now() - started, completed: false } });
    }
  });
}

export function registerInstructionTools(server: McpServer, getClient: () => DebugServerClient | null) {
  async function run(options: unknown, over: boolean, signal?: AbortSignal) {
    try {
      const client = getClient(); if (!client?.isConnected()) throw new Error('Connect to DebugServer first');
      return { content: [{ type: 'text' as const, text: JSON.stringify(await runInstructionSteps(client, options, over, signal), null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({
        error: error instanceof Error ? error.message : 'Instruction operation failed', completed: false,
        ...(error instanceof Error && 'partial' in error ? { partial: error.partial } : {}),
      }, null, 2) }] };
    }
  }
  const description = 'Paused EE/IOP instruction control with native identity/PC guards and owned breakpoint cleanup. timeout_ms=10-5000 bounds execution (default 1000); count shares one budget. CPU preparation/cleanup may add latency. Cancellation is checked between native commands; an in-flight command reaches its native deadline. Returns structured steps and partial results on errors. Legacy step targets PC+4; use source stepping for supported EE branches/delay slots. Requires rebuilt bounded_instruction_step.';
  server.tool('pcsx2_step', description, instructionOptions.shape, (options, extra) => run(options, false, extra.signal));
  server.tool('pcsx2_step_over', 'Step over a physical JAL/JALR call, otherwise the legacy PC+4 instruction. '+description,
    instructionOptions.omit({ count: true }).shape, (options, extra) => run({ ...options, count: 1 }, true, extra.signal));
}
