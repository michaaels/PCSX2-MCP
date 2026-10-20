import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DebugServerClient } from './debug-server-client.js';

async function portOccupied() {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: 21512 });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => {
      socket.destroy();
      if ('code' in error && error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Cannot determine whether debug port 21512 is occupied')); });
  });
}

export async function validateElf(filename: string) {
  const file = await fs.open(filename, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error('ELF must be a file no larger than 256 MiB');
    const header = Buffer.alloc(52);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== 52 || header.toString('hex', 0, 4) !== '7f454c46' || header[4] !== 1 || header[5] !== 1 || header.readUInt16LE(18) !== 8) {
      throw new Error('Expected a 32-bit little-endian MIPS ELF');
    }
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
    return { sha256: hash.digest('hex'), entry: '0x' + header.readUInt32LE(24).toString(16).padStart(8, '0') };
  } finally { await file.close(); }
}

export class EmulatorLauncher {
  private child?: ChildProcess;
  private client?: DebugServerClient;
  private busy = false;

  async launch(options: { executable: string; elf: string; portable?: boolean; timeoutMs?: number; signal?: AbortSignal }) {
    if (this.busy || this.child) throw new Error('This MCP already owns a running or starting emulator');
    this.busy = true;
    try {
      if (!path.isAbsolute(options.executable) || !path.isAbsolute(options.elf)) throw new Error('Executable and ELF paths must be absolute');
      if (/[\x00-\x1f]/.test(options.executable + options.elf)) throw new Error('Paths cannot contain control characters');
      if (!(await fs.stat(options.executable)).isFile()) throw new Error('PCSX2 executable must be a file');
      const identity = await validateElf(options.elf);
      options.signal?.throwIfAborted();
      if (await portOccupied()) throw new Error('Debug port 21512 is occupied. Attach with pcsx2_connect instead.');
      const args = [...(options.portable === false ? [] : ['-portable']), '-nogui', '-fastboot', options.elf];
      const child = spawn(options.executable, args, { cwd: path.dirname(options.executable), windowsHide: true, stdio: 'ignore' });
      this.child = child;
      // A launched game survives a clean MCP/Codex restart; reconnect afterward.
      child.unref();
      let spawnError: Error | undefined;
      let exited = false;
      child.once('error', error => { spawnError = error; });
      child.once('exit', () => {
        exited = true;
        if (this.child === child) { this.child = undefined; this.client?.disconnect(); this.client = undefined; }
      });
      const deadline = performance.now() + (options.timeoutMs ?? 20000);
      try {
        while (performance.now() < deadline) {
          options.signal?.throwIfAborted();
          if (spawnError) throw spawnError;
          if (exited) throw new Error(`PCSX2 exited before DebugServer startup (code ${child.exitCode})`);
          const candidate = new DebugServerClient();
          try {
            await candidate.connect();
            const capabilities = await candidate.getCapabilities();
            if (capabilities.process_id !== child.pid) throw new Error('DebugServer process identity does not match the launched emulator; rebuild the native patch');
            this.client = candidate;
            return { client: candidate, result: { pid: child.pid, executable: options.executable, elf: options.elf, ...identity, capabilities } };
          } catch (error) {
            candidate.disconnect();
            if (!/ECONNREFUSED|connection closed/i.test(error instanceof Error ? error.message : String(error))) throw error;
          }
          await delay(100, undefined, { signal: options.signal });
        }
        throw new Error('Timed out waiting for the launched PCSX2 DebugServer');
      } catch (error) {
        await this.terminateOwned(child);
        throw error;
      }
    } finally { this.busy = false; }
  }

  private async terminateOwned(child: ChildProcess) {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      await new Promise<void>((resolve, reject) => {
        const onExit = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { child.off('exit', onExit); reject(new Error('Owned emulator did not exit within five seconds')); }, 5000);
        child.once('exit', onExit);
        if (!child.kill()) { clearTimeout(timer); child.off('exit', onExit); reject(new Error('Could not terminate the owned emulator process')); }
      });
    }
    if (this.child === child) this.child = undefined;
    this.client?.disconnect(); this.client = undefined;
  }

  async stop() {
    if (this.busy) throw new Error('An emulator lifecycle operation is already in progress');
    if (!this.child) throw new Error('No emulator owned by this MCP; attached external instances cannot be stopped by this tool');
    this.busy = true;
    try {
      const pid = this.child.pid;
      await this.terminateOwned(this.child);
      return { stopped: true, pid };
    } finally { this.busy = false; }
  }
}
