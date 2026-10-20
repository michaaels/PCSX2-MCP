import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { inspectSourceElf, runSourceTool, SourceResolver } from './source-debug.js';
import { DebugServerClient } from './debug-server-client.js';
import { address } from './symbols.js';
import type { StepIdentity } from './guarded-step.js';

export const sourceStepOptions = z.object({
  mode: z.enum(['into', 'over', 'out']).default('into'),
  max_instruction_units: z.number().int().min(1).max(4096).default(512),
  timeout_ms: z.number().int().min(100).max(30000).default(5000),
  expected_sha256: z.string().regex(/^[\da-fA-F]{64}$/).optional(),
});
const rangesResponse = z.object({ sha256: z.string(), current: z.object({ file: z.string(), line: z.number().int().positive() }),
  locations: z.array(z.object({ file: z.string(), line: z.number().int().positive(), address,
    end: z.number().int().positive().max(0x100000000) })).min(1).max(4096) });
const sameIdentity = (a: StepIdentity, b: Awaited<ReturnType<DebugServerClient['getCapabilities']>>) =>
  (['process_id', 'session', 'elf', 'elf_crc', 'execution_epoch'] as const).every(key => a[key] === b[key]);

/** Source policy is file/line changes, not address order. Calls are actually executed,
 * instruction by instruction, including during over/out. No guessed stack frames. */
export class SourceStepper {
  constructor(private readonly options: { python?: string; runner?: typeof runSourceTool; resolver?: SourceResolver } = {}) {}

  async run(client: DebugServerClient, input: z.input<typeof sourceStepOptions>, signal?: AbortSignal) {
    const options = sourceStepOptions.parse(input);
    return client.withExclusiveSession(async () => {
      signal?.throwIfAborted();
      const caps = await client.getCapabilities();
      if (!caps.features.includes('guarded_step') || caps.process_id === undefined || caps.execution_epoch === undefined)
        throw new Error('Rebuild PCSX2: guarded_step and execution epoch are required');
      const expected: StepIdentity = { process_id: caps.process_id, session: caps.session, elf: caps.elf,
        elf_crc: caps.elf_crc, execution_epoch: caps.execution_epoch };
      const initial = await client.getStatus();
      if (!initial.alive || !initial.paused) throw new Error('Pause the active EE VM before source stepping');
      const filename = caps.elf.startsWith('host:') ? caps.elf.slice(5) : caps.elf;
      if (!path.isAbsolute(filename)) throw new Error('Source stepping requires the loaded absolute local debug ELF path');
      const elf = await inspectSourceElf(filename);
      if (!elf.has_debug_lines || Number(elf.elf_crc) !== Number(caps.elf_crc)) throw new Error('Loaded debug ELF/CRC does not match');
      if (options.expected_sha256 && elf.sha256 !== options.expected_sha256.toLowerCase()) throw new Error('ELF SHA256 does not match expected_sha256');
      const resolver = this.options.resolver ?? new SourceResolver();
      const source = async (pc: string, abort?: AbortSignal) => (await resolver.resolve({ elf: elf.elf, addresses: [pc], expected_sha256: elf.sha256 }, abort, caps.elf_crc)).locations[0];
      const before = await source(initial.pc, signal);
      if (!before.resolved) throw new Error('Current PC has no source information; VM remains paused');
      if (options.mode === 'out' && before.frames.length > 1) throw new Error('Out of an inline frame is unsupported; select a physical frame');
      const root = fileURLToPath(new URL('../', import.meta.url));
      const python = this.options.python ?? process.env.PCSX2_DWARF_PYTHON ?? path.join(root, '.venv-dwarf', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      if (!path.isAbsolute(python)) throw new Error('PCSX2_DWARF_PYTHON must be an absolute executable path');
      if (!this.options.runner) await fs.access(python).catch(() => { throw new Error('Install the optional pinned DWARF backend; see docs/source-breakpoints.md'); });
      const map = rangesResponse.parse(JSON.parse(await (this.options.runner ?? runSourceTool)(python,
        ['-I', '-X', 'utf8', path.join(root, 'python/dwarf_lines.py'), elf.elf, '--pc', initial.pc], { signal, timeoutMs: 15000 })));
      if (map.sha256 !== elf.sha256 || (await inspectSourceElf(elf.elf)).sha256 !== elf.sha256) throw new Error('ELF changed during stepping preparation');
      const ranges = map.locations.filter(row => row.file === map.current.file && row.line === map.current.line && Number(row.address) < row.end &&
        elf.executable_ranges.some(range => Number(row.address) >= range.start && row.end <= range.end));
      const contains = (pc: string) => ranges.some(row => Number(pc) >= Number(row.address) && Number(pc) < row.end);
      if (!contains(initial.pc)) throw new Error('No executable DWARF interval at current PC');
      if (!sameIdentity(expected, await client.getCapabilities())) throw new Error('VM changed during source stepping preparation');
      signal?.throwIfAborted();

      let pc = initial.pc, units = 0, steps = 0, reason = 'instruction_limit', error: string | null = null;
      let pending: number | undefined, cleanupComplete = true, starting = false;
      const returns: number[] = [], trace: unknown[] = [];
      const started = performance.now(), deadline = started + options.timeout_ms;
      try {
        while (units < options.max_instruction_units) {
          if (signal?.aborted) { reason = 'cancelled'; break; }
          const remaining = Math.floor(deadline - performance.now());
          if (remaining < 10) { reason = 'timeout'; break; }
          const previousPc = pc;
          starting = true;
          let result = await client.startGuardedStep(expected, pc, Math.min(2, options.max_instruction_units - units), Math.min(1000, remaining));
          starting = false;
          pending = result.operation_id;
          while (result.active) {
            if (signal?.aborted || performance.now() >= deadline) {
              result = await client.guardedStepStatus(pending, true);
              reason = signal?.aborted ? 'cancelled' : 'timeout';
              break;
            }
            await delay(2);
            result = await client.guardedStepStatus(pending);
          }
          if (result.active || !result.paused) throw new Error('Guarded step did not confirm a stopped VM');
          pending = undefined; cleanupComplete = result.cleanup_complete;
          pc = result.pc; units += result.instruction_units; steps++;
          trace.push(result); if (trace.length > 32) trace.shift();
          if (!cleanupComplete) { reason = 'cleanup_incomplete'; break; }
          if (result.execution_epoch !== expected.execution_epoch) { reason = 'vm_changed'; break; }
          if (reason === 'cancelled' || reason === 'timeout') break;
          if (result.reason !== 'completed') { reason = result.reason; break; }
          if (Number(result.old_pc) !== Number(previousPc))
            throw new Error('Guarded step returned an unexpected starting PC');
          if (Number(pc) !== Number(result.target)) { reason = 'unexpected_pc'; break; }
          if (result.is_call) {
            if (returns.length >= 64) { reason = 'call_depth_limit'; break; }
            returns.push((Number(result.old_pc) + 8) >>> 0);
          }
          if (result.is_return) {
            if (returns.length) {
              if (returns.pop() !== Number(pc)) { reason = 'return_mismatch'; break; }
            } else if (options.mode === 'out') { reason = 'returned'; break; }
          }
          if (options.mode !== 'out' && (options.mode === 'into' || returns.length === 0) && !contains(pc)) {
            reason = 'source_changed'; break;
          }
        }
      } catch (failure) {
        error = String(failure);
        reason = failure instanceof Error && 'native_rejected' in failure ? 'native_refused' : 'error';
        if (starting && reason !== 'native_refused') cleanupComplete = false;
        if (reason === 'native_refused' && /Insufficient instruction budget/.test(error)) reason = 'instruction_limit';
        if (failure instanceof Error && 'operation_id' in failure && Number.isSafeInteger(failure.operation_id)) pending = Number(failure.operation_id);
      } finally {
        if (pending !== undefined) {
          try { const final = await client.guardedStepStatus(pending, true); cleanupComplete = final.cleanup_complete && final.paused && !final.active; pc = final.pc; }
          catch (failure) { cleanupComplete = false; error = `${error ?? ''}; cleanup: ${String(failure)}`; }
        }
      }
      const elapsed = Math.round(performance.now() - started);
      let after: typeof before | null = null, paused: boolean | null = null, identityMatches = false;
      try {
        identityMatches = sameIdentity(expected, await client.getCapabilities());
        if (!identityMatches) reason = 'vm_changed';
        else {
          const status = await client.getStatus(); paused = status.paused; pc = status.pc;
          if (!paused) { reason = 'vm_running'; cleanupComplete = false; }
          else if ((await inspectSourceElf(elf.elf)).sha256 !== elf.sha256) reason = 'elf_changed';
          else if (!signal?.aborted) {
            after = await source(pc, signal);
            const verified = await client.getStatus();
            if (!verified.paused || Number(verified.pc) !== Number(pc) || !sameIdentity(expected, await client.getCapabilities())) {
              reason = 'state_changed_during_snapshot'; identityMatches = false;
            }
          }
        }
      } catch (failure) { reason = signal?.aborted ? 'cancelled' : 'final_snapshot_error'; error = `${error ?? ''}; final snapshot: ${String(failure)}`; }
      if (reason === 'source_changed' && (!after?.resolved || !after.frames.some(frame => frame.file && frame.line))) reason = 'no_source';
      // Table boundaries can distinguish columns/discriminators without changing a source line.
      if (reason === 'source_changed' && after?.frames[0]?.file === before.frames[0]?.file && after.frames[0]?.line === before.frames[0]?.line)
        reason = 'same_source_line';
      return { mode: options.mode, reason, completed: ['source_changed', 'returned'].includes(reason) && cleanupComplete && identityMatches && paused === true,
        elf: elf.elf, sha256: elf.sha256, runtime: expected, old_pc: initial.pc, pc, before, after,
        instruction_units: units, steps, execution_elapsed_ms: elapsed, paused, cleanup_complete: cleanupComplete,
        identity_matches: identityMatches, error, trace, trace_truncated: steps > trace.length,
        policy: 'file_line_change_physical_calls_jr_ra_returns', pending_operation_id: cleanupComplete ? null : pending ?? null };
    });
  }
}
