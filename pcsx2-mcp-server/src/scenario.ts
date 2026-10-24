import { z } from 'zod';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DebugServerClient } from './debug-server-client.js';
import { inputOptions } from './automation.js';
import { address, cpu } from './symbols.js';
import { writeContextArtifacts } from './context-artifacts.js';
import { visualAssertionOptions } from './visual-comparison.js';
import { compareScenarioScreenshot } from './visual-tools.js';

const name = z.string().min(1).max(128);
const frameCount = z.number().int().min(1).max(600).default(1);
const bounds = { width: z.number().int().min(1).max(1280).default(640), height: z.number().int().min(1).max(1024).default(480) };
const stepTimeout = z.number().int().min(1).max(15000).default(10000);
export const scenarioStep = z.discriminatedUnion('action', [
  z.object({ action: z.literal('frames'), frames: frameCount }).strict(),
  z.object({ action: z.literal('input'), ...inputOptions.shape, frames: frameCount }).strict(),
  z.object({ action: z.literal('assert_memory'), address, expected_hex: z.string().min(2).max(8192).regex(/^(?:[\da-fA-F]{2})+$/), cpu }).strict(),
  z.object({ action: z.literal('assert_expression'), expression: z.string().min(1).max(256),
    equals: z.string().regex(/^(?:0x[\da-fA-F]{1,16}|\d{1,20})$/), cpu }).strict(),
  z.object({ action: z.literal('assert_log'), contains: z.string().min(1).max(256) }).strict(),
  z.object({ action: z.literal('assert_controller'), ...inputOptions.shape }).strict(),
  z.object({ action: z.literal('run_to_symbol'), symbol: z.string().min(1).max(256), cpu, timeout_ms: stepTimeout }).strict(),
  z.object({ action: z.literal('run_to_address'), address, cpu, timeout_ms: stepTimeout }).strict(),
  z.object({ action: z.literal('screenshot'), ...bounds, expected_sha256: z.string().regex(/^[\da-f]{64}$/i).optional() }).strict(),
  z.object({ action: z.literal('assert_screenshot'), ...bounds, ...visualAssertionOptions.shape }).strict(),
  z.object({ action: z.literal('context'), ...bounds, cpu,
    memory_address: address.default('0x0'), memory_length: z.number().int().min(0).max(4096).default(0) }).strict(),
]);
export const scenarioSchema = z.object({
  name, expected_elf_crc: address.optional(), steps: z.array(scenarioStep).min(1).max(64),
}).strict();
export type ScenarioInput = z.input<typeof scenarioSchema>;
type Step = z.infer<typeof scenarioStep>;

const numericAddress = (value: string) => Number.parseInt(value.replace(/^0x/, ''), 16);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

export class ScenarioRunner {
  async run(client: DebugServerClient, input: ScenarioInput, outputDirectory: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    const scenario = scenarioSchema.parse(input);
    const timeout = z.number().int().min(1).max(45000).parse(options.timeoutMs ?? 30000);
    return client.withExclusiveSession(async () => {
      options.signal?.throwIfAborted();
      await fs.mkdir(path.resolve(outputDirectory), { recursive: true });
      const directory = await fs.mkdtemp(path.join(path.resolve(outputDirectory), 'pcsx2-scenario-'));
      const report: Record<string, any> = { name: scenario.name, started_at: new Date().toISOString(), passed: false,
        steps: [], artifacts: { directory, report: path.join(directory, 'report.json') } };
      await fs.writeFile(path.join(directory, 'scenario.json'), JSON.stringify(scenario, null, 2), { flag: 'wx' });
      const controller = new AbortController();
      const onAbort = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      const timer = setTimeout(() => controller.abort(new Error('Scenario deadline exceeded')), timeout);
      const signal = controller.signal;
      const deadline = performance.now() + timeout;
      const logCache: { sequence: number; message: string }[] = [];
      let logCursor = 0;
      let identity: Awaited<ReturnType<DebugServerClient['getCapabilities']>> | undefined;
      let touchedVM = false;
      let allowDiagnostic = false;
      let identityChanged = false;
      function sameIdentity(current: Awaited<ReturnType<DebugServerClient['getCapabilities']>>) {
        const same = identity && current.session === identity.session && current.process_id === identity.process_id &&
            current.elf === identity.elf && current.elf_crc === identity.elf_crc && current.execution_epoch === identity.execution_epoch;
        if (!same) { identityChanged = true; report.vm_changed = true; }
        return same;
      }
      async function readLogs(discard = false) {
        for (let pages = 0; pages < 16; pages++) {
          signal.throwIfAborted();
          const page = await client.readLogs(logCursor, 200);
          if (!discard) {
            check(!page.dropped, 'Console history was overwritten during the scenario');
            logCache.push(...page.logs);
            check(logCache.length <= 4096, 'Scenario console capture exceeds 4096 messages');
          }
          if (page.next_cursor === logCursor) return;
          logCursor = page.next_cursor;
        }
        throw new Error('Console history is growing too quickly to capture a stable cursor');
      }
      async function eventTail() {
        let cursor = 0;
        for (let pages = 0; pages < 8; pages++) {
          const page = await client.readEvents(cursor, 200);
          if (page.next_cursor === cursor) return cursor;
          cursor = page.next_cursor;
        }
        throw new Error('Cannot establish a current event cursor');
      }
      async function ensureIdentity() {
        signal.throwIfAborted();
        const current = await client.getCapabilities();
        check(sameIdentity(current), 'VM/ELF identity changed during the scenario');
      }
      async function runTo(target: string, cpuTarget: 'ee' | 'iop', waitMs: number) {
        target = '0x' + numericAddress(target).toString(16).padStart(8, '0');
        if (numericAddress((await client.getStatus(cpuTarget)).pc) === numericAddress(target)) return { address: target, already_at_target: true };
        const existing = await client.listBreakpoints(cpuTarget);
        check(!existing.some(bp => numericAddress(bp.address) === numericAddress(target)), 'A breakpoint already exists at the scenario target; it was left unchanged');
        let owned = false;
        try {
          await client.setBreakpoint(target, { cpu: cpuTarget }); owned = true;
          report.pending_breakpoint = { address: target, cpu: cpuTarget };
          const cursor = await eventTail();
          await client.resume(cpuTarget);
          const event = await client.waitEvent({ after: cursor, type: 'breakpoint', timeoutMs: Math.max(0, Math.min(waitMs, Math.floor(deadline - performance.now()))), signal });
          check(!event.dropped, 'Breakpoint event history was overwritten');
          check(!event.timed_out && event.events.some(hit => hit.cpu === cpuTarget && numericAddress(hit.pc) === numericAddress(target)), 'Did not reach the requested breakpoint before the deadline or stopped at a different breakpoint');
          return { address: target, events: event.events };
        } finally {
          if (owned) {
            check(sameIdentity(await client.getCapabilities()), 'VM/ELF identity changed; breakpoint cleanup was skipped');
            await client.pause(cpuTarget);
            await client.removeBreakpoint(target, cpuTarget);
            delete report.pending_breakpoint;
          }
        }
      }
      async function execute(step: Step, index: number): Promise<unknown> {
        const remaining = Math.max(1, Math.min(30000, Math.floor(deadline - performance.now())));
        const prefix = `step-${String(index + 1).padStart(3, '0')}`;
        switch (step.action) {
          case 'frames': case 'input': {
            const result = await client.advanceFrames(step.frames, { input: step.action === 'input' ? step : undefined, timeoutMs: remaining, signal });
            check(result.completed, `Frame execution interrupted: ${result.reason}`); return result;
          }
          case 'assert_memory': {
            const actual = await client.readMemoryStrict(step.address, step.expected_hex.length / 2, step.cpu);
            check(actual.toLowerCase() === step.expected_hex.toLowerCase(), `Memory mismatch at ${step.address}: expected ${step.expected_hex}, got ${actual}`);
            return { address: step.address, length: actual.length / 2, matched: true };
          }
          case 'assert_expression': {
            const result = await client.evaluate(step.expression, step.cpu);
            check(result.ok && result.hex && /^(?:0x)?[\da-fA-F]{1,16}$/.test(result.hex), result.error ?? 'Invalid native expression result');
            const actual = BigInt('0x' + result.hex.replace(/^0x/, ''));
            const expected = BigInt(step.equals);
            check(expected <= 0xffffffffffffffffn, 'Expression expectation exceeds unsigned 64-bit range');
            check(actual === expected, `Expression mismatch: expected ${step.equals}, got ${result.hex}`);
            return { expression: step.expression, hex: result.hex, matched: true };
          }
          case 'assert_log': {
            await readLogs();
            const found = logCache.find(log => log.message.includes(step.contains));
            check(found, `No new console message contains: ${step.contains}`);
            return { contains: step.contains, sequence: found.sequence, matched: true };
          }
          case 'assert_controller': {
            const actual = await client.getController(step.controller);
            const expected = [...new Set(step.buttons)].sort();
            check(JSON.stringify([...actual.buttons].sort()) === JSON.stringify(expected), 'Virtual controller buttons do not match');
            for (const axis of ['left_x', 'left_y', 'right_x', 'right_y'] as const) check(actual[axis] === step[axis], `Controller ${axis} mismatch`);
            return { ...actual, matched: true };
          }
          case 'run_to_symbol': {
            const found = await client.lookupSymbols({ query: step.symbol, exact: true, kind: 'function', cpu: step.cpu, limit: 100 });
            const targets = [...new Set(found.symbols.map(symbol => symbol.address))];
            check(!found.has_more && targets.length === 1, 'Function symbol is missing or ambiguous');
            return runTo(targets[0], step.cpu, step.timeout_ms);
          }
          case 'run_to_address': return runTo(step.address, step.cpu, step.timeout_ms);
          case 'screenshot': {
            const image = await client.captureScreenshot(step.width, step.height);
            const bytes = Buffer.from(image.data, 'base64');
            const filename = path.join(directory, prefix + '.png');
            await fs.writeFile(filename, bytes, { flag: 'wx' });
            const hash = createHash('sha256').update(bytes).digest('hex');
            check(!step.expected_sha256 || step.expected_sha256.toLowerCase() === hash, `Screenshot SHA256 mismatch: got ${hash}; image saved at ${filename}`);
            return { file: filename, width: image.width, height: image.height, sha256: hash };
          }
          case 'assert_screenshot': {
            const { action: _action, width, height, ...visual } = step;
            const compared = await compareScenarioScreenshot(client, visual, { width, height }, directory, signal);
            // Preserve comparison artifacts when the assertion throws, so a
            // stopped scenario still explains exactly which regions failed.
            report.steps[index].result = compared;
            check(compared.passed, `Visual screenshot regression: ${compared.reason}; report saved at ${compared.artifacts.report.path}`);
            return compared;
          }
          case 'context': {
            const context = await client.captureContext({ cpu: step.cpu, width: step.width, height: step.height, memoryAddress: step.memory_address, memoryLength: step.memory_length });
            const saved = await writeContextArtifacts(context, directory, prefix);
            check(context.screenshot.ok, 'Context is partial because no rendered frame is available');
            return saved.artifacts;
          }
        }
      }
      try {
        identity = await client.getCapabilities(); report.identity = identity;
        check(identity.elf.length > 0, 'Boot an ELF and wait for its current ELF/CRC before running a scenario');
        if (scenario.expected_elf_crc) check(numericAddress(identity.elf_crc) === numericAddress(scenario.expected_elf_crc), 'ELF CRC does not match the scenario');
        allowDiagnostic = true;
        touchedVM = true; await client.pause();
        await readLogs(true);
        for (let index = 0; index < scenario.steps.length; index++) {
          const step = scenario.steps[index];
          const record: Record<string, any> = { index: index + 1, action: step.action, passed: false };
          report.steps.push(record);
          const start = performance.now();
          try {
            await ensureIdentity();
            record.result = await execute(step, index);
            await ensureIdentity();
            signal.throwIfAborted();
            record.passed = true;
          } catch (error) { record.error = errorText(error); throw error; }
          finally { record.duration_ms = Math.round(performance.now() - start); }
        }
        report.passed = true;
      } catch (error) {
        report.error = errorText(error);
        if (allowDiagnostic && !identityChanged) {
          try {
              check(sameIdentity(await client.getCapabilities()), 'VM/ELF/epoch changed; failure diagnostic capture skipped');
            await client.pause(); touchedVM = true;
            const context = await client.captureContext();
            report.diagnostic = (await writeContextArtifacts(context, directory, 'failure')).artifacts;
          } catch (diagnostic) { report.diagnostic_error = errorText(diagnostic); }
        }
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (touchedVM && !identityChanged) {
          try { await client.pause(); check((await client.getStatus()).paused, 'Final VM pause could not be confirmed'); report.final_paused = true; }
          catch (error) { report.cleanup_error = errorText(error); report.passed = false; report.final_paused = false; }
        } else if (touchedVM) {
          report.cleanup_error = 'VM/ELF identity changed; final pause and diagnostic capture were skipped';
          report.final_paused = false;
          report.passed = false;
        }
        report.finished_at = new Date().toISOString();
        await fs.writeFile(report.artifacts.report, JSON.stringify(report, null, 2), { flag: 'wx' });
      }
      return report;
    });
  }
}
