import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { inspectSourceElf, runSourceTool } from './source-debug.js';
import { address } from './symbols.js';
import { DebugServerClient } from './debug-server-client.js';

const sourcePath = z.string().min(1).max(4096).refine(value => !/[\x00-\x1f]/.test(value), 'Path contains control characters');
const absolute = (value: string) => value.startsWith('/') || /^[a-z]:[\\/]/i.test(value);
export const lineOptions = z.object({
  elf: sourcePath, file: sourcePath, line: z.number().int().min(1).max(2147483647),
  expected_sha256: z.string().regex(/^[\da-fA-F]{64}$/).optional(),
  path_mappings: z.array(z.object({ from: sourcePath.refine(absolute), to: sourcePath.refine(absolute) }).strict()).max(16).default([]),
});
const location = z.object({ file: sourcePath, address, line: z.number().int().positive(), column: z.number().int().nonnegative(), discriminator: z.number().int().nonnegative() });
const decoded = z.object({ format_version: z.literal(1), sha256: z.string().regex(/^[\da-f]{64}$/),
  dwarf_versions: z.array(z.number().int().min(2).max(5)).max(4), files: z.array(sourcePath).max(4096), locations: z.array(location).max(4096) });
const slash = (value: string) => {
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  return normalized === '/' || /^[a-z]:\/$/i.test(normalized) ? normalized : normalized.replace(/\/$/, '');
};
const key = (value: string) => /^[a-z]:\//i.test(value) || value.startsWith('//') ? value.toLowerCase() : value;

export function selectSourceFile(files: string[], requested: string, mappings: { from: string; to: string }[]) {
  const query = slash(requested);
  if (query === '.' || requested.replaceAll('\\', '/').split('/').includes('..')) throw new Error('Source query must identify a file without parent traversal');
  const normalized = mappings.map(mapping => ({ from: slash(mapping.from), to: slash(mapping.to) })).sort((a, b) => b.from.length - a.from.length);
  if (new Set(normalized.map(mapping => key(mapping.from))).size !== normalized.length) throw new Error('Duplicate source mapping prefix');
  const entries = [...new Set(files.map(slash))].map(original => {
    const mapping = normalized.find(item => key(original) === key(item.from) || key(original).startsWith(key(item.from).replace(/\/$/, '') + '/'));
    return { original, mapped: mapping ? slash(mapping.to + '/' + original.slice(mapping.from.length).replace(/^\//, '')) : original };
  });
  const matches = entries.filter(entry => [entry.original, entry.mapped].some(candidate => absolute(query)
    ? key(candidate) === key(query) : candidate === query || candidate.endsWith('/' + query)));
  if (matches.length === 0) throw new Error('Source file not found in ELF line tables; use a recorded path or explicit path_mappings');
  if (matches.length !== 1) throw new Error(`Source file is ambiguous (${matches.length} matches): ${matches.slice(0, 8).map(item => item.original).join(', ')}`);
  return matches[0];
}

type Runner = typeof runSourceTool;
export class SourceLineResolver {
  constructor(private readonly options: { python?: string; runner?: Runner } = {}) {}
  async resolve(input: z.input<typeof lineOptions>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const options = lineOptions.parse(input);
    const elf = await inspectSourceElf(options.elf);
    if (options.expected_sha256 && options.expected_sha256.toLowerCase() !== elf.sha256) throw new Error('ELF SHA256 does not match expected_sha256');
    if (!elf.has_debug_lines) throw new Error('ELF has no debug line section; retain an unstripped debug build');
    const root = fileURLToPath(new URL('../', import.meta.url));
    const python = this.options.python ?? process.env.PCSX2_DWARF_PYTHON ?? path.join(root, '.venv-dwarf', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (!path.isAbsolute(python)) throw new Error('PCSX2_DWARF_PYTHON must be an absolute Python executable path');
    if (!this.options.runner) await fs.access(python).catch(() => { throw new Error('Source line lookup needs the optional Python backend. Create .venv-dwarf and install requirements-dwarf.txt (see docs/source-debugging.md)'); });
    const output = await (this.options.runner ?? runSourceTool)(python, ['-I', '-X', 'utf8', path.join(root, 'python/dwarf_lines.py'), elf.elf, String(options.line)], { signal, timeoutMs: 15000 });
    const result = decoded.parse(JSON.parse(output));
    if (result.sha256 !== elf.sha256) throw new Error('ELF changed before DWARF decoding');
    const selected = selectSourceFile(result.files, options.file, options.path_mappings);
    const locations = result.locations.filter(item => slash(item.file) === selected.original && item.line === options.line && Number(item.address) % 4 === 0 &&
      elf.executable_ranges.some(range => Number(item.address) >= range.start && Number(item.address) + 4 <= range.end));
    const addresses = [...new Set(locations.map(item => item.address))].sort((a, b) => Number(a) - Number(b));
    if (addresses.length > 64) throw new Error('Source line has more than 64 executable statement locations');
    // Hash again: backend and caller must observe the same complete file, not just mtime.
    if ((await inspectSourceElf(elf.elf)).sha256 !== elf.sha256) throw new Error('ELF changed during source line lookup');
    signal?.throwIfAborted();
    return { elf: elf.elf, sha256: elf.sha256, elf_crc: elf.elf_crc, file: selected.original, mapped_file: selected.mapped,
      requested_line: options.line, resolved_line: addresses.length ? options.line : null, addresses, locations, resolved: addresses.length > 0,
      reason: addresses.length ? null : 'no_executable_statement_on_exact_line', dwarf_versions: result.dwarf_versions,
      policy: 'all_exact_line_statement_addresses', backend: 'pyelftools-0.33' };
  }

  async install(client: DebugServerClient, input: z.input<typeof lineOptions>, signal?: AbortSignal) {
    return client.withExclusiveSession(async () => {
      signal?.throwIfAborted();
      const before = await client.getCapabilities();
      if (!before.features.includes('source_breakpoints')) throw new Error('Rebuild PCSX2: native source_breakpoints capability is required');
      const processId = before.process_id;
      if (processId === undefined) throw new Error('Native process identity is required for source breakpoint installation');
      if (!(await client.getStatus()).paused) throw new Error('Pause the VM before installing source breakpoints');
      const resolved = await this.resolve(input, signal);
      if (!resolved.resolved) throw new Error('No executable statement on that exact source line; no breakpoint installed');
      const loaded = before.elf.startsWith('host:') ? before.elf.slice(5) : before.elf;
      if (!path.isAbsolute(loaded) || key(slash(await fs.realpath(loaded))) !== key(slash(resolved.elf)) || Number(before.elf_crc) !== Number(resolved.elf_crc)) {
        throw new Error('Debug ELF path/CRC does not match the running EE ELF');
      }
      signal?.throwIfAborted();
      const groupId = randomUUID().replaceAll('-', '');
      try {
        const installed = await client.installSourceBreakpoints(groupId, resolved.addresses, { ...before, process_id: processId });
        signal?.throwIfAborted();
        const after = await client.getCapabilities();
        if (['process_id', 'session', 'elf', 'elf_crc'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after])) throw new Error('VM identity changed during source breakpoint installation');
        if ((await inspectSourceElf(resolved.elf)).sha256 !== resolved.sha256) throw new Error('ELF changed during breakpoint installation');
        return { ...resolved, ...installed, cpu: 'ee', resumes_vm: false };
      } catch (error) {
        if (error instanceof Error && 'native_rejected' in error) throw error; // Native validation changed nothing.
        let cleanup: unknown;
        try { cleanup = await client.removeSourceBreakpoints(groupId); }
        catch (cleanupError) { cleanup = { error: String(cleanupError), pending_group_id: groupId }; }
        throw Object.assign(new Error(`Source breakpoint installation failed: ${String(error)}`), { cleanup, group_id: groupId });
      }
    });
  }
}
