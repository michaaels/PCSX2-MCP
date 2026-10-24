import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as path from 'node:path';
import { DebugServerClient } from './debug-server-client.js';
import { inspectSourceElf } from './source-debug.js';
import { compareVisualFiles, decodeVisualPng, readVisualReference, saveVisualComparison, visualAssertionOptions, visualFileOptions } from './visual-comparison.js';

export function registerVisualTools(server: McpServer) {
  server.tool('pcsx2_compare_screenshots', 'Compare two hash-pinned local opaque RGB/RGBA PNGs offline, with bounded dimensions, channel/pixel tolerances, named nonoverlapping regions and ignored rectangles. Saves input copies, diff and JSON in a new folder, even for a visual mismatch. Does not connect to or change a VM, resize images, infer a baseline build or perform perceptual/gameplay validation.',
    visualFileOptions.shape, async (input, extra) => {
      try {
        const report = await compareVisualFiles(input, extra.signal);
        return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }], isError: !report.passed };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error instanceof Error ? error.message : 'Visual comparison failed' }) }], isError: true };
      }
    });
}

/** Called only inside the scenario's exclusive session; never pauses/resumes. */
export async function compareScenarioScreenshot(client: DebugServerClient, input: z.input<typeof visualAssertionOptions>,
  bounds: { width: number; height: number }, outputDirectory: string, signal?: AbortSignal) {
  const o = visualAssertionOptions.parse(input);
  const baseline = await readVisualReference(o.baseline_path, o.baseline_sha256, signal);
  decodeVisualPng(baseline);
  const before = await client.getCapabilities(), status = await client.getStatus();
  if (!status.paused || before.process_id === undefined || before.execution_epoch === undefined)
    throw new Error('Visual scenario assertion requires paused VM with process/session/execution epoch');
  const loaded = before.elf.startsWith('host:') ? before.elf.slice(5) : before.elf;
  if (!path.isAbsolute(loaded)) throw new Error('Visual scenario assertion requires a loaded absolute local ELF');
  const elf = await inspectSourceElf(loaded);
  if (elf.sha256 !== o.expected_elf_sha256 || elf.elf_crc !== before.elf_crc) throw new Error('Visual assertion ELF SHA256 or CRC mismatch');
  signal?.throwIfAborted(); const started = Date.now();
  const image = await client.captureScreenshot(bounds.width, bounds.height);
  const after = await client.getCapabilities(), statusAfter = await client.getStatus();
  for (const key of ['process_id', 'session', 'execution_epoch', 'elf', 'elf_crc'] as const)
    if (before[key] !== after[key]) throw new Error('VM/ELF/epoch identity changed during visual capture');
  if (!statusAfter.paused || statusAfter.pc !== status.pc || statusAfter.cycles !== status.cycles)
    throw new Error('Paused CPU state changed during visual capture');
  const verified = await inspectSourceElf(loaded);
  if (verified.sha256 !== elf.sha256 || verified.elf !== elf.elf || verified.version !== elf.version) throw new Error('Visual assertion ELF file changed');
  return saveVisualComparison(baseline, Buffer.from(image.data, 'base64'), o.policy, outputDirectory, {
    process_id: before.process_id, session: before.session, execution_epoch: before.execution_epoch,
    elf_sha256: elf.sha256, elf_crc: elf.elf_crc, paused_cpu: { pc: status.pc, cycles: status.cycles },
    capture_bracket_ms: { started, ended: Date.now() }, frame_relation: 'rendered_GS_frame_not_atomic_CPU_or_game_state',
    baseline_build_identity: 'not_independently_verified',
  }, signal);
}
