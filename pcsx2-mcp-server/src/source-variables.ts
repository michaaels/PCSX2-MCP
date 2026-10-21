import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DebugServerClient } from './debug-server-client.js';
import { inspectSourceElf, runSourceTool } from './source-debug.js';
import { variableOptions, variableMetadata, VariableReader, VariableUnavailable } from './variables.js';
import { z } from 'zod';

export class SourceVariables {
  constructor(private options: { python?: string; runner?: typeof runSourceTool } = {}) {}
  async inspect(client: DebugServerClient, input: z.input<typeof variableOptions>, signal?: AbortSignal) {
    const options = variableOptions.parse(input);
    return client.withExclusiveSession(async () => {
      signal?.throwIfAborted();
      const caps = await client.getCapabilities();
      if (!caps.features.includes('variable_inspection') || caps.process_id === undefined || caps.execution_epoch === undefined)
        throw new Error('Rebuild PCSX2: native variable_inspection capability is required');
      const identity = { process_id: caps.process_id, session: caps.session, elf: caps.elf, elf_crc: caps.elf_crc, execution_epoch: caps.execution_epoch };
      const initial = await client.inspectEE(identity);
      const filename = caps.elf.startsWith('host:') ? caps.elf.slice(5) : caps.elf;
      if (!path.isAbsolute(filename)) throw new Error('Variable inspection requires a local loaded debug ELF');
      const elf = await inspectSourceElf(filename);
      if (!elf.has_debug_lines || Number(elf.elf_crc) !== Number(caps.elf_crc)) throw new Error('Loaded debug ELF/CRC does not match');
      if (options.expected_sha256 && options.expected_sha256.toLowerCase() !== elf.sha256) throw new Error('ELF SHA256 does not match expected_sha256');
      if (!elf.executable_ranges.some(range => Number(initial.pc) >= range.start && Number(initial.pc) < range.end)) throw new Error('PC is outside loaded executable segments');
      const root = fileURLToPath(new URL('../', import.meta.url));
      const python = this.options.python ?? process.env.PCSX2_DWARF_PYTHON ?? path.join(root, '.venv-dwarf', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      if (!path.isAbsolute(python)) throw new Error('PCSX2_DWARF_PYTHON must be absolute');
      if (!this.options.runner) await fs.access(python).catch(() => { throw new Error('Install the optional pinned DWARF backend; see docs/source-breakpoints.md'); });
      const metadata = variableMetadata.parse(JSON.parse(await (this.options.runner ?? runSourceTool)(python,
        ['-I', '-X', 'utf8', path.join(root, 'python/dwarf_variables.py'), elf.elf, initial.pc], { signal, timeoutMs: 15000 })));
      if (metadata.sha256 !== elf.sha256 || Number(metadata.pc) !== Number(initial.pc) || !metadata.ranges.some(([start, end]) => start <= Number(initial.pc) && Number(initial.pc) < end))
        throw new Error('DWARF metadata does not match ELF/current PC');
      const guard = { revision: initial.revision, pc: initial.pc };
      const snapshot = async (address?: string, length?: number) => {
        signal?.throwIfAborted();
        const result = await client.inspectEE(identity, guard, address, length);
        if (result.gpr.some((reg, index) => reg !== initial.gpr[index])) throw new Error('EE registers changed; discard variable inspection');
        return result;
      };
      await snapshot(); // Metadata decoding must not permit a resumed/replaced state.
      const reader = new VariableReader(metadata, initial.gpr, async (address, length) => {
        const memory = (await snapshot(address, length)).memory;
        if (!memory || memory.address !== address || memory.length !== length) throw new Error('Unexpected guarded memory extent');
        if (!memory.valid) throw new VariableUnavailable(memory.reason ?? 'invalid_memory');
        return memory.hex!;
      }, options, signal);
      const selected = metadata.variables.filter(variable => !options.names || options.names.includes(variable.name));
      const variables = [];
      for (const variable of selected.slice(0, options.max_variables)) {
        signal?.throwIfAborted();
        if (reader.nodes >= options.max_nodes) break;
        const info = { id: variable.id, name: variable.name, kind: variable.kind, scope: variable.scope, location: variable.location };
        try {
          if (metadata.location_guard !== 'compiler_reported') throw new VariableUnavailable(`unavailable_during_${metadata.location_guard}`);
          variables.push({ ...info, ...await reader.render(variable.name, variable.type, await reader.expression(variable.location)) });
        } catch (error) {
          if (!(error instanceof VariableUnavailable)) throw error;
          reader.nodes++; variables.push({ ...info, type_id: variable.type, status: error.message });
        }
      }
      if ((await inspectSourceElf(elf.elf)).sha256 !== elf.sha256) throw new Error('ELF changed during variable inspection');
      await snapshot();
      return { cpu: 'ee', frame_index: 0, elf: elf.elf, sha256: elf.sha256, runtime: identity,
        snapshot: initial, paused_at_snapshot: true, function: metadata.function, source_line: metadata.source_line, dwarf_version: metadata.dwarf_version,
        frame_base: metadata.frame_base, cfa: metadata.cfa, scopes: metadata.scopes, inline_scopes: metadata.inline_scopes,
        location_guard: metadata.location_guard, variables, truncated: variables.length < selected.length,
        missing_names: options.names?.filter(name => !selected.some(variable => variable.name === name)) ?? [],
        bytes_requested: reader.bytes, bytes_read: reader.bytesRead, memory_requests: reader.reads, nodes: reader.nodes, read_only: true,
        limits: { max_bytes: options.max_bytes, max_nodes: options.max_nodes, max_depth: options.max_depth, max_children: options.max_children,
          max_variables: options.max_variables, max_memory_requests: 64, follow_pointers: options.follow_pointers },
        warnings: metadata.has_prologue_marker ? [] : ['No DWARF prologue-end marker: beyond the entry/declaration line, validity follows compiler locations; legacy optimized locations may be imprecise in prologues/epilogues.'] };
    });
  }
}
