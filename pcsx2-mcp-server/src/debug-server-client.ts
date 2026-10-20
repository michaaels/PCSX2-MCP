/**
 * PCSX2 Debug Server Client
 * Talks to the custom C++ JSON/TCP server inside PCSX2 (port 21512)
 * 
 * This REPLACES the GDB client — gives us EVERYTHING:
 *   - Full 128-bit registers (all 7 categories)
 *   - Native PCSX2 disassembly
 *   - Expression evaluation with symbol lookup
 *   - Conditional breakpoints
 *   - Memory watchpoints (read/write/onChange)
 *   - Step and step-over (delay slot aware)
 *   - Thread list, module list
 *   - String reading, address validation
 * 
 * Protocol: newline-delimited JSON over TCP
 * Request:  {"cmd":"...", ...}\n
 * Response: {"ok":true, ...}\n
 */

import * as net from 'node:net';
import { parseScreenshot, type Screenshot } from './screenshot.js';
import { capabilitiesResponse, eventsResponse, logsResponse, parseContext, type DebugEventType } from './debug-session.js';
import { z } from 'zod';
import { automationResponse, controllerResponse, inputOptions, buttons, type InputOptions } from './automation.js';
import { setTimeout as delay } from 'node:timers/promises';

export interface DebugRegister {
  name: string;
  value: string;  // 32-char hex string (128-bit)
  display: string; // PCSX2's formatted display
}

export interface RegisterCategory {
  size: number;  // bits per register
  count: number;
  regs: DebugRegister[];
}


export interface DisasmInstruction {
  address: string;
  opcode: string;
  disasm: string;
}

export interface BreakpointInfo {
  address: string;
  enabled: boolean;
  temporary: boolean;
  stepping: boolean;
  has_condition: boolean;
  condition?: string;
  description?: string;
}

export interface MemcheckInfo {
  start: string;
  end: string;
  hits: number;
  last_pc: string;
  last_addr: string;
  description?: string;
}

export interface ThreadInfo {
  id: number;
  pc: string;
  status: number;
  wait_type: number;
}

export interface StepResult {
  old_pc: string;
  new_pc: string;
  disasm: string;
  opcode: string;
}

export interface EvalResult {
  ok: boolean;
  result?: number;
  hex?: string;
  error?: string;
}

type CpuTarget = 'ee' | 'iop';

export class DebugServerClient {
  private host: string;
  private port: number;
  private socket: net.Socket | null = null;
  private connected = false;
  private responseBuffer = '';
  private pendingResolve: ((data: any) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  private commandQueue: Promise<void> = Promise.resolve();
  private automationBusy = false;

  constructor(host = '127.0.0.1', port = 21512) {
    this.host = host;
    this.port = port;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      this.socket.setEncoding('utf8');

      const timeout = setTimeout(() => {
        this.socket?.destroy();
        reject(new Error(`Connection timeout to DebugServer at ${this.host}:${this.port}`));
      }, 3000);

      this.socket.connect(this.port, this.host, () => {
        clearTimeout(timeout);
        this.connected = true;
        resolve();
      });

      this.socket.on('data', (data: string) => {
        // The largest supported PNG is 6 MiB (8 MiB base64 plus JSON).
        if (this.responseBuffer.length + data.length > 9 * 1024 * 1024) {
          this.pendingReject?.(new Error('DebugServer response exceeds 9 MiB limit'));
          this.pendingResolve = null;
          this.pendingReject = null;
          this.responseBuffer = '';
          this.connected = false;
          this.socket?.destroy();
          return;
        }
        this.responseBuffer += data;
        this.processBuffer();
      });

      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        this.connected = false;
        if (this.pendingReject) {
          this.pendingReject(err);
          this.pendingResolve = null;
          this.pendingReject = null;
        } else {
          reject(err);
        }
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.pendingReject?.(new Error('DebugServer connection closed'));
        this.pendingResolve = null;
        this.pendingReject = null;
      });
    });
  }

  private processBuffer(): void {
    const newlineIdx = this.responseBuffer.indexOf('\n');
    if (newlineIdx < 0) return;

    const line = this.responseBuffer.substring(0, newlineIdx);
    this.responseBuffer = this.responseBuffer.substring(newlineIdx + 1);

    if (this.pendingResolve) {
      try {
        const data = JSON.parse(line);
        this.pendingResolve(data);
      } catch (e) {
        if (this.pendingReject) this.pendingReject(new Error(`Invalid JSON: ${line}`));
      }
      this.pendingResolve = null;
      this.pendingReject = null;
    }
  }

  private async send(cmd: Record<string, any>): Promise<any> {
    // The newline protocol has no request IDs, so replies must stay in order.
    const result = this.commandQueue.then(() => this.sendCommand(cmd));
    this.commandQueue = result.then(() => {}, () => {});
    return result;
  }

  private async sendCommand(cmd: Record<string, any>): Promise<any> {
    if (!this.connected || !this.socket) {
      throw new Error('Not connected to PCSX2 Debug Server');
    }

    return new Promise((resolve, reject) => {
      const onError = (err: Error) => { clearTimeout(timeout); reject(err); };
      const timeout = setTimeout(() => {
        if (this.pendingReject === onError) {
          this.pendingResolve = null;
          this.pendingReject = null;
          // A late reply cannot be matched safely to the next command.
          this.connected = false;
          this.socket?.destroy();
          reject(new Error(`Command timeout: ${cmd.cmd}`));
        }
      }, 10000);
      this.pendingResolve = (data) => { clearTimeout(timeout); resolve(data); };
      this.pendingReject = onError;
      this.socket!.write(JSON.stringify(cmd) + '\n');
    });
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  isConnected(): boolean { return this.connected; }

  private async sessionCommand(command: Record<string, unknown>): Promise<any> {
    const response = await this.send(command);
    if (!response.ok) {
      const hint = typeof response.error === 'string' && response.error.startsWith('Unknown command')
        ? ' Rebuild PCSX2 with the updated DebugServer.' : '';
      throw new Error(`${response.error}${hint}`);
    }
    return response;
  }

  async getCapabilities() {
    return capabilitiesResponse.parse(await this.sessionCommand({ cmd: 'capabilities' }));
  }

  async getController(controller = 0) {
    z.number().int().min(0).max(1).parse(controller);
    const result = controllerResponse.parse(await this.sessionCommand({ cmd: 'controller_state', controller }));
    return { ...result, buttons: buttons.filter((_, index) => result.pressed_mask & (1 << index)) };
  }

  async startFrameAdvance(frames = 1, input?: InputOptions) {
    z.number().int().min(1).max(600).parse(frames);
    const parsed = input === undefined ? undefined : inputOptions.parse(input);
    return automationResponse.parse(await this.sessionCommand({ cmd: parsed ? 'input_frames' : 'frame_advance', frames,
      ...(parsed && { ...parsed, buttons: parsed.buttons.reduce((mask, button) => mask | (1 << buttons.indexOf(button)), 0) }),
    }));
  }

  async getAutomation(operationId: number) {
    z.number().int().positive().safe().parse(operationId);
    return automationResponse.parse(await this.sessionCommand({ cmd: 'automation_status', operation_id: operationId }));
  }

  async cancelAutomation(operationId: number) {
    z.number().int().positive().safe().parse(operationId);
    return automationResponse.parse(await this.sessionCommand({ cmd: 'automation_cancel', operation_id: operationId }));
  }

  async advanceFrames(frames: number, options: { input?: InputOptions; timeoutMs?: number; signal?: AbortSignal } = {}) {
    const timeout = z.number().int().min(1).max(30000).parse(options.timeoutMs ?? 20000);
    options.signal?.throwIfAborted();
    if (this.automationBusy) throw new Error('A frame/input operation is already pending on this connection');
    this.automationBusy = true;
    try {
      const socket = this.socket;
      let started;
      try { started = await this.startFrameAdvance(frames, options.input); }
      catch (error) {
        if (!this.isConnected()) throw new Error(`Frame startup failed without an operation ID; cancellation could not be confirmed: ${error instanceof Error ? error.message : error}`);
        throw error;
      }
      const deadline = performance.now() + timeout;
      try {
        for (;;) {
          options.signal?.throwIfAborted();
          if (this.socket !== socket) throw new Error('DebugServer connection changed during automation');
          const result = await this.getAutomation(started.operation_id);
          if (!result.active) return { ...result, completed: result.reason === 'completed' && result.frames_advanced === frames };
          if (performance.now() >= deadline) throw new Error(`Frame operation ${started.operation_id} timed out`);
          await delay(25, undefined, { signal: options.signal });
        }
      } catch (error) {
        try {
          if (this.socket !== socket) throw new Error('Original connection is no longer available');
          await this.cancelAutomation(started.operation_id);
        } catch (cleanup) {
          throw new Error(`${error instanceof Error ? error.message : error}; cancellation could not be confirmed: ${cleanup instanceof Error ? cleanup.message : cleanup}`);
        }
        throw error;
      }
    } finally { this.automationBusy = false; }
  }

  async readEvents(after = 0, limit = 100, waitMs = 0) {
    z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(after);
    z.number().int().min(1).max(200).parse(limit);
    z.number().int().min(0).max(1000).parse(waitMs);
    return eventsResponse.parse(await this.sessionCommand({ cmd: 'read_events', after, limit, wait_ms: waitMs }));
  }

  async waitEvent(options: { after?: number; type?: DebugEventType; timeoutMs?: number; signal?: AbortSignal } = {}) {
    let after = options.after ?? 0;
    const timeout = z.number().int().min(0).max(30000).parse(options.timeoutMs ?? 10000);
    const deadline = performance.now() + timeout;
    let dropped = false;
    do {
      options.signal?.throwIfAborted();
      // Small native long-polls leave room for resume/other commands on this connection.
      const batch = await this.readEvents(after, 200, Math.max(0, Math.min(250, Math.floor(deadline - performance.now()))));
      options.signal?.throwIfAborted();
      dropped ||= batch.dropped;
      after = batch.next_cursor;
      const matches = batch.events.filter(event => !options.type || event.type === options.type);
      if (matches.length) return { ...batch, events: matches, dropped, timed_out: false };
      if (performance.now() >= deadline) return { ...batch, events: [], dropped, timed_out: true };
    } while (true);
  }

  async readLogs(after = 0, limit = 100) {
    z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(after);
    z.number().int().min(1).max(200).parse(limit);
    return logsResponse.parse(await this.sessionCommand({ cmd: 'read_logs', after, limit }));
  }

  async loadElf(filename: string) {
    z.string().min(1).max(4096)
      .refine(value => /^(?:[a-zA-Z]:[\\/]|[\\/]{2}|\/)/.test(value), 'ELF path must be absolute on the emulator host')
      .refine(value => !/[\x00-\x1f]/.test(value), 'ELF path contains control characters').parse(filename);
    return z.object({ ok: z.literal(true), path: z.string(), reset_requested: z.literal(true) })
      .parse(await this.sessionCommand({ cmd: 'load_elf', path: filename }));
  }

  async captureContext(options: { cpu?: CpuTarget; width?: number; height?: number; memoryAddress?: string; memoryLength?: number } = {}) {
    const width = z.number().int().min(1).max(1280).parse(options.width ?? 640);
    const height = z.number().int().min(1).max(1024).parse(options.height ?? 480);
    const memoryLength = z.number().int().min(0).max(4096).parse(options.memoryLength ?? 0);
    const memoryAddress = z.string().regex(/^(?:0x)?[\da-fA-F]{1,8}$/).parse(options.memoryAddress ?? '0x0');
    const result = parseContext(await this.sessionCommand({ cmd: 'capture_context', cpu: options.cpu ?? 'ee',
      width, height, memory_address: `0x${memoryAddress.replace(/^0x/, '')}`, memory_length: memoryLength }));
    if (result.screenshot.ok && (result.screenshot.width > width || result.screenshot.height > height)) {
      throw new Error('Context screenshot exceeds requested dimensions');
    }
    return result;
  }

  // ===== Status =====

  async getStatus(cpu: CpuTarget = 'ee'): Promise<{ alive: boolean; paused: boolean; pc: string; cycles: number }> {
    const resp = await this.send({ cmd: 'status', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.data;
  }

  // ===== Screenshots =====

  /** Capture the current GS frame. Requires a rebuilt DebugServer with screenshot support. */
  async captureScreenshot(width = 640, height = 480): Promise<Screenshot> {
    if (!Number.isInteger(width) || width < 1 || width > 1280 ||
        !Number.isInteger(height) || height < 1 || height > 1024) {
      throw new Error('Screenshot width must be 1-1280 and height 1-1024');
    }
    const resp = await this.send({ cmd: 'screenshot', width, height });
    if (!resp.ok) {
      const hint = typeof resp.error === 'string' && resp.error.startsWith('Unknown command')
        ? ' Rebuild PCSX2 with the updated DebugServer.' : '';
      throw new Error(`Screenshot failed: ${resp.error}${hint}`);
    }
    const screenshot = parseScreenshot(resp);
    if (screenshot.width > width || screenshot.height > height) {
      throw new Error('Screenshot exceeds requested dimensions');
    }
    return screenshot;
  }

  // ===== Registers =====

  /** Read all registers (all categories or specific one) */
  async readRegisters(cpu: CpuTarget = 'ee', category?: number): Promise<any> {
    const cmd: any = { cmd: 'read_registers', cpu };
    if (category !== undefined) cmd.category = category;
    const resp = await this.send(cmd);
    if (!resp.ok) throw new Error(resp.error);
    return resp.data;
  }

  /** Write a 128-bit register */
  async writeRegister(category: number, index: number, value: string, cpu: CpuTarget = 'ee'): Promise<void> {
    const resp = await this.send({ cmd: 'write_register', cpu, category, index, value });
    if (!resp.ok) throw new Error(resp.error);
  }

  /** Set the Program Counter */
  async setPC(value: string, cpu: CpuTarget = 'ee'): Promise<void> {
    const resp = await this.send({ cmd: 'set_pc', cpu, value });
    if (!resp.ok) throw new Error(resp.error);
  }

  // ===== Memory =====

  /** Read memory as hex string */
  async readMemory(address: string, length: number, cpu: CpuTarget = 'ee'): Promise<string> {
    const resp = await this.send({ cmd: 'read_memory', cpu, address, length });
    if (!resp.ok) throw new Error(resp.error);
    return resp.hex;
  }

  /** Read memory as Buffer */
  async readMemoryBuffer(address: string, length: number, cpu: CpuTarget = 'ee'): Promise<Buffer> {
    const hex = await this.readMemory(address, length, cpu);
    return Buffer.from(hex, 'hex');
  }

  /** Write memory from hex string */
  async writeMemory(address: string, data: string, cpu: CpuTarget = 'ee'): Promise<number> {
    const resp = await this.send({ cmd: 'write_memory', cpu, address, data });
    if (!resp.ok) throw new Error(resp.error);
    return resp.written;
  }

  /** Read a null-terminated string */
  async readString(address: string, maxLength = 256, cpu: CpuTarget = 'ee'): Promise<string> {
    const resp = await this.send({ cmd: 'read_string', cpu, address, max_length: maxLength });
    if (!resp.ok) throw new Error(resp.error);
    return resp.string;
  }

  /** Check if an address is valid */
  async isValidAddress(address: string, cpu: CpuTarget = 'ee'): Promise<boolean> {
    const resp = await this.send({ cmd: 'is_valid_address', cpu, address });
    if (!resp.ok) throw new Error(resp.error);
    return resp.valid;
  }

  // ===== Disassembly (NATIVE PCSX2!) =====

  /** Disassemble using PCSX2's own disassembler — perfect output */
  async disassemble(address: string, count = 20, simplify = true, cpu: CpuTarget = 'ee'): Promise<DisasmInstruction[]> {
    const resp = await this.send({ cmd: 'disassemble', cpu, address, count, simplify });
    if (!resp.ok) throw new Error(resp.error);
    return resp.instructions;
  }

  // ===== Expression Evaluation =====

  /** Evaluate a MIPS expression (e.g., "v0 + 0x100", "gp + 0x20") with symbol support */
  async evaluate(expression: string, cpu: CpuTarget = 'ee'): Promise<EvalResult> {
    const resp = await this.send({ cmd: 'evaluate', cpu, expression });
    return resp;
  }

  // ===== Breakpoints =====

  /** Set a breakpoint (optionally with condition expression and description) */
  async setBreakpoint(address: string, options?: { condition?: string; description?: string; temporary?: boolean; cpu?: CpuTarget }): Promise<void> {
    const resp = await this.send({
      cmd: 'set_breakpoint',
      cpu: options?.cpu || 'ee',
      address,
      condition: options?.condition,
      description: options?.description,
      temporary: options?.temporary ?? false,
    });
    if (!resp.ok) throw new Error(resp.error);
  }

  async removeBreakpoint(address: string, cpu: CpuTarget = 'ee'): Promise<void> {
    const resp = await this.send({ cmd: 'remove_breakpoint', cpu, address });
    if (!resp.ok) throw new Error(resp.error);
  }

  async listBreakpoints(cpu: CpuTarget = 'ee'): Promise<BreakpointInfo[]> {
    const resp = await this.send({ cmd: 'list_breakpoints', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.breakpoints;
  }

  // ===== Memory Watchpoints =====

  /** Set a memory watchpoint (read/write/access/onchange) with optional condition */
  async setMemcheck(address: string, end: string, options?: {
    type?: 'read' | 'write' | 'readwrite' | 'onchange';
    action?: 'break' | 'log' | 'both';
    condition?: string;
    description?: string;
    cpu?: CpuTarget;
  }): Promise<void> {
    const resp = await this.send({
      cmd: 'set_memcheck',
      cpu: options?.cpu || 'ee',
      address,
      end,
      type: options?.type || 'write',
      action: options?.action || 'break',
      condition: options?.condition,
      description: options?.description,
    });
    if (!resp.ok) throw new Error(resp.error);
  }

  async removeMemcheck(address: string, end: string, cpu: CpuTarget = 'ee'): Promise<void> {
    const resp = await this.send({ cmd: 'remove_memcheck', cpu, address, end });
    if (!resp.ok) throw new Error(resp.error);
  }

  async listMemchecks(cpu: CpuTarget = 'ee'): Promise<MemcheckInfo[]> {
    const resp = await this.send({ cmd: 'list_memchecks', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.memchecks;
  }

  // ===== Execution Control =====

  async pause(cpu: CpuTarget = 'ee'): Promise<string> {
    const resp = await this.send({ cmd: 'pause', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.pc;
  }

  async resume(cpu: CpuTarget = 'ee'): Promise<void> {
    const resp = await this.send({ cmd: 'resume', cpu });
    if (!resp.ok) throw new Error(resp.error);
  }

  /** Single-step one instruction (delay slot aware) */
  async step(cpu: CpuTarget = 'ee'): Promise<StepResult> {
    const resp = await this.send({ cmd: 'step', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp;
  }

  /** Step over a JAL/JALR — effectively "next" */
  async stepOver(cpu: CpuTarget = 'ee'): Promise<StepResult> {
    const resp = await this.send({ cmd: 'step_over', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp;
  }

  // ===== Thread/Module Info =====

  async getThreads(cpu: CpuTarget = 'ee'): Promise<ThreadInfo[]> {
    const resp = await this.send({ cmd: 'get_threads', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.threads;
  }

  async getModules(cpu: CpuTarget = 'iop'): Promise<Array<{ name: string; version: number }>> {
    const resp = await this.send({ cmd: 'get_modules', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.modules;
  }

  /** Get call stack backtrace using PCSX2's MipsStackWalk */
  async getBacktrace(cpu: CpuTarget = 'ee', maxFrames = 32): Promise<Array<{ entry: string; pc: string; sp: string; stack_size: number; disasm: string }>> {
    const resp = await this.send({ cmd: 'get_backtrace', cpu, max_frames: maxFrames });
    if (!resp.ok) throw new Error(resp.error);
    return resp.frames;
  }

  // ===== Bulk Operations =====

  async clearAllBreakpoints(): Promise<void> {
    const resp = await this.send({ cmd: 'clear_breakpoints' });
    if (!resp.ok) throw new Error(resp.error);
  }
}
