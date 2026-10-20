import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { address } from './symbols.js';
import { DebugServerClient } from './debug-server-client.js';

const hex = (value: number) => '0x' + value.toString(16).padStart(8, '0');
const normalize = (value: string) => hex(Number.parseInt(address.parse(value), 16));
export const sourceOptions = z.object({
  elf: z.string().min(1), addresses: z.array(address).min(1).max(64),
  expected_sha256: z.string().regex(/^[\da-fA-F]{64}$/).optional(),
});
type RunOptions = { signal?: AbortSignal; timeoutMs: number };
type ToolRunner = (command: string, args: string[], options: RunOptions) => Promise<string>;
type ResolverOptions = {
  backend?: 'auto' | 'native' | 'wsl'; command?: string; distribution?: string;
  platform?: NodeJS.Platform; runner?: ToolRunner;
};

// No shell, stdin or arbitrary per-call command. Bound both diagnostic streams together.
export const runSourceTool: ToolRunner = async (command, args, { signal, timeoutMs }) => {
  signal?.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', DEBUGINFOD_URLS: '' } });
    let stdout = ''; let stderr = ''; let bytes = 0; let failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; child.kill(); };
    const abort = () => stop(new Error('Source lookup cancelled'));
    const timer = setTimeout(() => stop(new Error('Source tool timed out')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    // Cover cancellation between the initial check and listener registration.
    if (signal?.aborted) abort();
    child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
    const append = (chunk: string, diagnostic: boolean) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) { stop(new Error('Source tool output exceeds 1 MiB')); return; }
      if (diagnostic) stderr += chunk; else stdout += chunk;
    };
    child.stdout!.on('data', chunk => append(chunk, false));
    child.stderr!.on('data', chunk => append(chunk, true));
    child.once('error', error => { failure ??= error; });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0 || stderr.trim()) reject(new Error(`Source tool failed (${code}): ${stderr.trim().slice(0, 2000)}`));
      else resolve(stdout);
    });
  });
};

function signature(stat: Awaited<ReturnType<fs.FileHandle['stat']>>) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

export async function inspectSourceElf(filename: string) {
  if (!path.isAbsolute(filename) || /[\x00-\x1f]/.test(filename)) throw new Error('ELF path must be absolute without control characters');
  const canonical = await fs.realpath(filename);
  const file = await fs.open(canonical, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 52 || before.size > 256 * 1024 * 1024) throw new Error('ELF must be a file of 52 bytes to 256 MiB');
    const bytes = await file.readFile();
    const version = signature(before);
    if (version !== signature(await file.stat()) || bytes.length !== before.size) throw new Error('ELF changed while being read');
    if (bytes.toString('hex', 0, 4) !== '7f454c46' || bytes[4] !== 1 || bytes[5] !== 1 || bytes[6] !== 1 ||
        bytes.readUInt32LE(20) !== 1 || bytes.readUInt16LE(40) !== 52 ||
        bytes.readUInt16LE(18) !== 8 || bytes.readUInt16LE(16) !== 2) throw new Error('Expected a linked ELF32 little-endian MIPS executable (ET_EXEC)');
    const extent = (offset: number, length: number) => {
      if (offset + length > bytes.length) throw new Error('ELF table or section extends beyond the file');
    };
    const phoff = bytes.readUInt32LE(28), phsize = bytes.readUInt16LE(42), phnum = bytes.readUInt16LE(44);
    const shoff = bytes.readUInt32LE(32), shsize = bytes.readUInt16LE(46), shnum = bytes.readUInt16LE(48), namesIndex = bytes.readUInt16LE(50);
    if (phnum < 1 || phnum > 1024 || phsize !== 32 || shnum > 4096 || (!shnum && shoff !== 0) || (shnum && (shsize !== 40 || namesIndex >= shnum))) {
      throw new Error('Unsupported ELF header tables (extended numbering is not supported)');
    }
    extent(phoff, phsize * phnum); extent(shoff, shsize * shnum);
    const executable_ranges: { start: number; end: number }[] = [];
    for (let i = 0; i < phnum; i++) {
      const off = phoff + i * phsize;
      if (bytes.readUInt32LE(off) !== 1) continue;
      const start = bytes.readUInt32LE(off + 8), size = bytes.readUInt32LE(off + 20);
      const fileSize = bytes.readUInt32LE(off + 16);
      extent(bytes.readUInt32LE(off + 4), fileSize);
      if (fileSize > size || start + size > 0x100000000) throw new Error('Invalid ELF load segment');
      if (bytes.readUInt32LE(off + 24) & 1) executable_ranges.push({ start, end: start + size });
    }
    let has_debug_lines = false;
    if (shnum && namesIndex) {
      const off = shoff + namesIndex * shsize;
      const namesOffset = bytes.readUInt32LE(off + 16), namesSize = bytes.readUInt32LE(off + 20);
      extent(namesOffset, namesSize);
      const names = bytes.subarray(namesOffset, namesOffset + namesSize);
      for (let i = 0; i < shnum; i++) {
        const section = shoff + i * shsize, nameOffset = bytes.readUInt32LE(section);
        if (nameOffset >= names.length) throw new Error('Invalid ELF section name');
        const end = names.indexOf(0, nameOffset);
        if (end < 0) throw new Error('Unterminated ELF section name');
        const name = names.toString('utf8', nameOffset, end);
        if (name === '.debug_line' || name === '.zdebug_line') {
          const size = bytes.readUInt32LE(section + 20);
          extent(bytes.readUInt32LE(section + 16), size); has_debug_lines ||= size > 0;
        }
      }
    }
    // Matches ElfObject::GetCRC in PCSX2 v2.6.3: XOR little-endian words, ignore trailing bytes.
    let crc = 0;
    for (let offset = 0; offset + 4 <= bytes.length; offset += 4) crc ^= bytes.readUInt32LE(offset);
    return { elf: canonical, sha256: createHash('sha256').update(bytes).digest('hex'), elf_crc: hex(crc >>> 0),
      entry: hex(bytes.readUInt32LE(24)), has_debug_lines, executable_ranges, version };
  } finally { await file.close(); }
}

export type SourceFrame = { function: string | null; file: string | null; line: number | null; column: number | null; discriminator: number | null };
export function parseSourceOutput(output: string, addresses: string[]) {
  const lines = output.trimEnd().split(/\r?\n/); let cursor = 0;
  return addresses.map(input => {
    const requested = normalize(input);
    const marker = lines[cursor++];
    if (!/^0x[\da-f]+$/i.test(marker ?? '') || BigInt(marker) !== BigInt(requested)) throw new Error('Unexpected addr2line address marker');
    const frames: SourceFrame[] = [];
    while (cursor < lines.length && !/^0x[\da-f]+$/i.test(lines[cursor])) {
      const fn = lines[cursor++], location = lines[cursor++];
      const match = /^(.*?):(\d+|\?)(?::(\d+|\?))?(?: \(discriminator (\d+)\))?$/.exec(location ?? '');
      if (!match || frames.length >= 64) throw new Error('Malformed or excessive addr2line source frames');
      const line = Number(match[2]), column = Number(match[3]);
      if ((Number.isFinite(line) && !Number.isSafeInteger(line)) || (Number.isFinite(column) && !Number.isSafeInteger(column))) throw new Error('Invalid source line or column');
      frames.push({ function: fn === '??' ? null : fn, file: match[1] === '??' ? null : match[1],
        line: line > 0 ? line : null, column: column > 0 ? column : null, discriminator: match[4] ? Number(match[4]) : null });
    }
    if (!frames.length) throw new Error('Missing addr2line source frame');
    return { address: requested, resolved: frames.some(frame => frame.file !== null && frame.line !== null), frames };
  }).map((value, index, all) => {
    if (index === all.length - 1 && cursor !== lines.length) throw new Error('Unexpected trailing addr2line output');
    return value;
  });
}

export class SourceResolver {
  private readonly options: ResolverOptions;
  constructor(options: ResolverOptions = {}) {
    const backend = options.backend ?? process.env.PCSX2_ADDR2LINE_BACKEND ?? 'auto';
    if (!['auto', 'native', 'wsl'].includes(backend)) throw new Error('PCSX2_ADDR2LINE_BACKEND must be auto, native or wsl');
    this.options = { ...options, backend: backend as ResolverOptions['backend'],
      command: options.command ?? process.env.PCSX2_ADDR2LINE,
      distribution: options.distribution ?? process.env.PCSX2_ADDR2LINE_WSL_DISTRO };
  }

  private async invoke(elf: string, addresses: string[], signal?: AbortSignal) {
    const { backend, command, distribution } = this.options;
    const platform = this.options.platform ?? process.platform;
    const run = this.options.runner ?? runSourceTool;
    const options = { signal, timeoutMs: 10000 };
    const args = ['-a', '-f', '-C', '-i', '-e', elf, ...addresses];
    if (backend !== 'wsl') {
      if (command && !path.isAbsolute(command)) throw new Error('PCSX2_ADDR2LINE must be an absolute native executable path');
      for (const candidate of command ? [command] : ['mips64r5900el-ps2-elf-addr2line', 'llvm-addr2line', 'addr2line']) {
        try { return { output: await run(candidate, args, options), backend: 'native', command: candidate }; }
        catch (error) {
          if (command || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
      }
      if (backend === 'native' || platform !== 'win32') throw new Error('addr2line not found. Install PS2DEV/binutils or LLVM and set PCSX2_ADDR2LINE to its absolute path');
    }
    if (platform !== 'win32') throw new Error('The wsl addr2line backend is available only on Windows');
    if (command && backend === 'wsl' && (!command.startsWith('/') || /[\x00-\x1f]/.test(command))) throw new Error('WSL PCSX2_ADDR2LINE must be an absolute Linux path');
    if (distribution && !/^[\w. -]{1,128}$/.test(distribution)) throw new Error('Invalid WSL distribution name');
    const prefix = distribution ? ['--distribution', distribution, '--exec'] : ['--exec'];
    const translated = (await run('wsl.exe', [...prefix, 'wslpath', '-a', '-u', elf], options)).trimEnd();
    if (!translated.startsWith('/') || /[\x00-\x1f]/.test(translated)) throw new Error('Invalid ELF path returned by WSL');
    // Coreutils timeout also bounds the Linux worker if terminating wsl.exe does not reap it.
    const executable = backend === 'wsl' && command ? command : 'addr2line';
    const output = await run('wsl.exe', [...prefix, 'env', 'LC_ALL=C', 'LANG=C', 'DEBUGINFOD_URLS=',
      'timeout', '-s', 'KILL', '8s', executable, '-a', '-f', '-C', '-i', '-e', translated, ...addresses], options);
    return { output, backend: 'wsl', command: executable, distribution: distribution ?? null };
  }

  async resolve(input: z.input<typeof sourceOptions>, signal?: AbortSignal, expectedCrc?: string) {
    signal?.throwIfAborted();
    const options = sourceOptions.parse(input);
    const elf = await inspectSourceElf(options.elf);
    if (options.expected_sha256 && options.expected_sha256.toLowerCase() !== elf.sha256) throw new Error('ELF SHA256 does not match expected_sha256');
    if (expectedCrc && normalize(expectedCrc) !== elf.elf_crc) throw new Error('On-disk ELF CRC does not match the running ELF; keep the matching debug build');
    const addresses = options.addresses.map(normalize);
    const eligible = [...new Set(addresses.filter(value => elf.has_debug_lines && elf.executable_ranges.some(range => Number(value) >= range.start && Number(value) < range.end)))];
    const tool = eligible.length ? await this.invoke(elf.elf, eligible, signal) : null;
    const parsed = tool ? parseSourceOutput(tool.output, eligible) : [];
    signal?.throwIfAborted();
    if (signature(await fs.stat(elf.elf)) !== elf.version) throw new Error('ELF changed during source lookup');
    return { elf: elf.elf, sha256: elf.sha256, elf_crc: elf.elf_crc, entry: elf.entry, has_debug_lines: elf.has_debug_lines,
      tool: tool ? { backend: tool.backend, command: tool.command, ...('distribution' in tool ? { distribution: tool.distribution } : {}) } : null,
      locations: addresses.map(value => parsed.find(item => item.address === value) ?? { address: value, resolved: false, frames: [],
        reason: !elf.has_debug_lines ? 'no_debug_line_section' : 'outside_executable_segments' }) };
  }

  async currentPc(client: DebugServerClient, signal?: AbortSignal) {
    return client.withExclusiveSession(async () => {
      const before = await client.getCapabilities();
      if (!before.elf) throw new Error('Boot an EE ELF before resolving its current PC');
      const localElf = before.elf.startsWith('host:') ? before.elf.slice(5) : before.elf;
      if (!path.isAbsolute(localElf)) throw new Error('Running ELF is not an absolute local/host: path; use pcsx2_source_locations with its matching debug ELF');
      const status = await client.getStatus();
      const result = await this.resolve({ elf: localElf, addresses: [status.pc] }, signal, before.elf_crc);
      const after = await client.getCapabilities();
      if (['process_id', 'session', 'elf', 'elf_crc'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after])) throw new Error('VM identity changed during source lookup');
      return { ...result, cpu: 'ee', paused_at_snapshot: status.paused,
        runtime: { process_id: before.process_id, session: before.session, elf: before.elf, elf_crc: before.elf_crc, match: 'path_and_pcsx2_crc' } };
    });
  }
}
