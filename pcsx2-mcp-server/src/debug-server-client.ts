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
 *   - Bounded instruction control; guarded EE source stepping
 *   - Thread list, module list
 *   - String reading, address validation
 * 
 * Protocol: newline-delimited JSON over TCP
 * Request:  {"cmd":"...", ...}\n
 * Response: {"ok":true, ...}\n
 */

import * as net from 'node:net';
import { parseScreenshot, type Screenshot } from './screenshot.js';
import { applicationScreenshotOptions, parseApplicationScreenshot } from './application-screenshot.js';
import { capabilitiesResponse, eventsResponse, logsResponse, parseContext, type DebugEventType } from './debug-session.js';
import { z } from 'zod';
import { parseSifSnapshot, type SifIdentity } from './sif-state.js';
import { parseMovie, movieOptions, type MovieOptions, type ReplayOptions } from './input-movie.js';
import { automationResponse, controllerResponse, inputOptions, buttons, type InputOptions } from './automation.js';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { address, symbolOptions, symbolsResponse, resolvedResponse, symbolBreakpointResponse, type SymbolOptions } from './symbols.js';
import { guardedStepResponse, type StepIdentity } from './guarded-step.js';
import { exceptionOptions, exceptionState, watchId } from './exceptions.js';
import { progressOptions, progressState } from './progress.js';
import { memoryWatchOptions, memoryWatchState, memoryWatchList } from './memory-watch.js';
import { parseIopModuleSnapshot, parseIopModuleImage } from './iop-modules.js';
import { defaultPorts, tcpPort } from './ports.js';
import { dumpOptions, parseDump, type DumpOptions } from './gs-dump.js';
import { mediaOptions, parseMedia, type MediaOptions } from './media.js';
import { loadState } from './iop-load.js';
import { lifetimeResponse } from './iop-lifetime.js';

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

interface PendingDebugReply {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface DebugConnection {
  socket: net.Socket;
  state: 'connecting' | 'connected' | 'closed';
  buffer: string;
  bufferBytes: number;
  queue: Promise<void>;
  pending?: PendingDebugReply;
  connectTimer?: ReturnType<typeof setTimeout>;
  rejectConnect?: (error: Error) => void;
}

interface ConnectionScope { connection: DebugConnection }

export class DebugServerClient {
  private host: string;
  private port: number;
  private connection?: DebugConnection;
  private automationOwner?: ConnectionScope;
  private exclusiveScope?: ConnectionScope;
  private sessionScope = new AsyncLocalStorage<ConnectionScope>();

  private get socket(): net.Socket | undefined { return this.connection?.socket; }

  constructor(host = '127.0.0.1', port = defaultPorts().debug) {
    this.host = host;
    this.port = tcpPort.parse(port);
  }

  async connect(): Promise<void> {
    this.assertManagementScope();
    if (this.connection) this.retireConnection(this.connection, new Error('DebugServer connection replaced'));
    const connection: DebugConnection = { socket: new net.Socket(), state: 'connecting',
      buffer: '', bufferBytes: 0, queue: Promise.resolve() };
    this.connection = connection;
    connection.socket.setEncoding('utf8');
    return new Promise((resolve, reject) => {
      connection.rejectConnect = reject;
      connection.connectTimer = setTimeout(() => this.retireConnection(connection,
        new Error(`Connection timeout to DebugServer at ${this.host}:${this.port}`)), 3000);
      connection.socket.on('data', (data: string) => {
        if (this.connection !== connection || connection.state === 'closed') return;
        const bytes = Buffer.byteLength(data, 'utf8');
        if (connection.bufferBytes + bytes > 9 * 1024 * 1024) {
          this.retireConnection(connection, new Error('DebugServer response exceeds 9 MiB limit'));
          return;
        }
        connection.buffer += data; connection.bufferBytes += bytes;
        this.processBuffer(connection);
      });
      connection.socket.on('error', error => this.retireConnection(connection, error));
      connection.socket.on('close', () => this.retireConnection(connection, new Error('DebugServer connection closed')));
      connection.socket.connect(this.port, this.host, () => {
        if (this.connection !== connection || connection.state !== 'connecting') return;
        clearTimeout(connection.connectTimer); connection.connectTimer = undefined;
        connection.rejectConnect = undefined; connection.state = 'connected'; resolve();
      });
    });
  }

  private retireConnection(connection: DebugConnection, error: Error): void {
    if (connection.state === 'closed') return;
    connection.state = 'closed'; clearTimeout(connection.connectTimer);
    connection.connectTimer = undefined;
    const rejectConnect = connection.rejectConnect; connection.rejectConnect = undefined;
    const pending = connection.pending; connection.pending = undefined;
    connection.buffer = ''; connection.bufferBytes = 0;
    if (this.connection === connection) {
      this.connection = undefined;
      if (this.exclusiveScope?.connection === connection) this.exclusiveScope = undefined;
      if (this.automationOwner?.connection === connection) this.automationOwner = undefined;
    }
    rejectConnect?.(error);
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    connection.socket.destroy();
  }

  private processBuffer(connection: DebugConnection): void {
    if (this.connection !== connection || connection.state !== 'connected') return;
    if (!connection.pending) {
      this.retireConnection(connection, new Error('Unexpected DebugServer response without a pending command'));
      return;
    }
    const end = connection.buffer.indexOf('\n');
    if (end < 0) return;
    const line = connection.buffer.slice(0, end);
    connection.buffer = connection.buffer.slice(end + 1);
    connection.bufferBytes = Buffer.byteLength(connection.buffer, 'utf8');
    let data: unknown;
    try { data = JSON.parse(line); }
    catch {
      this.retireConnection(connection, new Error('Invalid JSON from DebugServer'));
      return;
    }
    const pending = connection.pending; connection.pending = undefined;
    clearTimeout(pending.timer); pending.resolve(data);
    // The protocol has no IDs or unsolicited notifications. No second request
    // can have been sent before this synchronous data callback returns.
    if (connection.buffer.length)
      this.retireConnection(connection, new Error('Unexpected trailing DebugServer response'));
  }

  private requireConnection(): DebugConnection {
    const connection = this.connection, scope = this.sessionScope.getStore();
    if (scope && scope.connection !== connection) throw new Error('DebugServer connection changed during operation');
    if (!connection || connection.state !== 'connected') throw new Error('Not connected to PCSX2 Debug Server');
    if (this.exclusiveScope && scope !== this.exclusiveScope)
      throw new Error('A scenario owns this DebugServer connection; wait or cancel that scenario first');
    return connection;
  }

  private async send(cmd: Record<string, any>): Promise<any> {
    const connection = this.requireConnection();
    // Bind at enqueue time: a retired command must never migrate to a new VM.
    const result = connection.queue.then(() => this.sendCommand(connection, cmd));
    connection.queue = result.then(() => {}, () => {});
    return result;
  }

  private async sendCommand(connection: DebugConnection, cmd: Record<string, any>): Promise<any> {
    if (this.connection !== connection || connection.state !== 'connected')
      throw new Error('DebugServer connection changed before queued command');
    const encoded = JSON.stringify(cmd) + '\n';
    return new Promise((resolve, reject) => {
      const pending: PendingDebugReply = { resolve, reject, timer: setTimeout(() => {
        if (connection.pending === pending)
          this.retireConnection(connection, new Error(`Command timeout: ${cmd.cmd}`));
      }, 10000) };
      connection.pending = pending;
      connection.socket.write(encoded, error => {
        if (error) this.retireConnection(connection, error);
      });
    });
  }

  disconnect(): void {
    this.assertManagementScope();
    if (this.connection) this.retireConnection(this.connection, new Error('DebugServer disconnected'));
  }

  private assertManagementScope(): void {
    const scope = this.sessionScope.getStore();
    if (scope && scope.connection !== this.connection) throw new Error('DebugServer connection changed during operation');
  }

  isConnected(): boolean { return this.connection?.state === 'connected'; }

  private async withConnectionScope<T>(operation: () => Promise<T>): Promise<T> {
    const connection = this.requireConnection();
    const result = await (this.sessionScope.getStore() ? operation() : this.sessionScope.run({ connection }, operation));
    if (this.connection !== connection || connection.state !== 'connected')
      throw new Error('DebugServer connection changed during operation');
    return result;
  }

  async withExclusiveSession<T>(operation: () => Promise<T>): Promise<T> {
    const connection = this.requireConnection();
    if (this.exclusiveScope || this.automationOwner) throw new Error('Another scenario or frame/input operation is active');
    const scope = { connection }; this.exclusiveScope = scope;
    try {
      await connection.queue;
      if (this.connection !== connection || connection.state !== 'connected')
        throw new Error('DebugServer connection changed before exclusive operation');
      const result = await this.sessionScope.run(scope, operation);
      if (this.connection !== connection || connection.state !== 'connected')
        throw new Error('DebugServer connection changed during exclusive operation');
      return result;
    } finally { if (this.exclusiveScope === scope) this.exclusiveScope = undefined; }
  }

  async installSourceBreakpoints(groupId: string, addresses: string[], expected: { session: number; process_id: number; elf: string; elf_crc: string }) {
    const response = await this.send({ cmd: 'install_source_breakpoints', cpu: 'ee', group_id: groupId,
      addresses: addresses.join(','), expected_session: expected.session, expected_process_id: expected.process_id,
      expected_elf: expected.elf, expected_elf_crc: expected.elf_crc });
    if (!response.ok) throw Object.assign(new Error(response.error ?? 'Native source breakpoint request rejected'), { native_rejected: true });
    const parsed = z.object({ ok: z.literal(true), group_id: z.string().regex(/^[\da-f]{32}$/),
      session: z.number().int().nonnegative(), elf: z.string(), elf_crc: address,
      addresses: z.array(address).min(1).max(64) }).parse(response);
    if (parsed.group_id !== groupId || parsed.session !== expected.session || parsed.elf !== expected.elf ||
        Number(parsed.elf_crc) !== Number(expected.elf_crc) || parsed.addresses.length !== addresses.length ||
        parsed.addresses.some((value, index) => Number(value) !== Number(addresses[index]))) throw new Error('Unexpected native source breakpoint identity/addresses');
    return parsed;
  }

  async startGuardedStep(expected: StepIdentity, pc: string, instructionBudget = 2, timeoutMs = 500) {
    address.parse(pc);
    z.number().int().min(1).max(2).parse(instructionBudget);
    z.number().int().min(10).max(1000).parse(timeoutMs);
    const response = await this.send({ cmd: 'guarded_step', cpu: 'ee', expected_pc: pc,
      expected_process_id: expected.process_id, expected_session: expected.session, expected_elf: expected.elf,
      expected_elf_crc: expected.elf_crc, expected_execution_epoch: expected.execution_epoch,
      instruction_budget: instructionBudget, timeout_ms: timeoutMs });
    if (!response.ok) throw Object.assign(new Error(response.error ?? 'Guarded step rejected'), { native_rejected: true });
    try { return guardedStepResponse.parse(response); }
    catch (error) { throw Object.assign(new Error(`Invalid guarded step response: ${String(error)}`), { operation_id: response.operation_id }); }
  }

  async inspectEE(expected: StepIdentity, guard?: { revision: number; pc: string }, addressValue?: string, length?: number) {
    if (addressValue !== undefined) { address.parse(addressValue); z.number().int().min(1).max(4096).parse(length); }
    const response = await this.sessionCommand({ cmd: 'inspect_ee', cpu: 'ee', expected_process_id: expected.process_id,
      expected_session: expected.session, expected_execution_epoch: expected.execution_epoch, expected_elf: expected.elf, expected_elf_crc: expected.elf_crc,
      ...(guard ? { expected_revision: guard.revision, expected_pc: guard.pc } : {}),
      ...(addressValue !== undefined ? { address: addressValue, length } : {}) });
    const memory = z.object({ address, length: z.number().int().min(1).max(4096), valid: z.boolean(), hex: z.string().regex(/^(?:[\da-f]{2})+$/).optional(), reason: z.string().optional() });
    const result = z.object({ ok: z.literal(true), revision: z.number().int().nonnegative().safe(), execution_epoch: z.number().int().nonnegative().safe(), pc: address,
      gpr: z.array(z.string().regex(/^(?:0x)?[\da-fA-F]{32}$/).transform(value => '0x' + value.replace(/^0x/, '').toLowerCase())).length(32), memory: memory.optional() }).parse(response);
    if (result.execution_epoch !== expected.execution_epoch || (guard && (result.revision !== guard.revision || Number(result.pc) !== Number(guard.pc))))
      throw new Error('Unexpected guarded inspection state');
    if (addressValue !== undefined && (!result.memory || result.memory.address !== addressValue || result.memory.length !== length ||
      (result.memory.valid && result.memory.hex?.length !== length! * 2) || (!result.memory.valid && result.memory.hex !== undefined))) throw new Error('Invalid guarded inspection memory response');
    return result;
  }

  async startMemoryWatch(id: string, expected: StepIdentity & { iop_reset_epoch?: number }, options: z.input<typeof memoryWatchOptions>) {
    watchId.parse(id); const o = memoryWatchOptions.parse(options);
    const response = await this.send({ cmd: 'memory_watch_start', watch_id: id, ...o,
      expected_iop_lifetime_epoch: expected.iop_lifetime_epoch,
      expected_process_id: expected.process_id, expected_session: expected.session, expected_execution_epoch: expected.execution_epoch,
      expected_elf: expected.elf, expected_elf_crc: expected.elf_crc, expected_iop_reset_epoch: expected.iop_reset_epoch });
    if (!response.ok) throw Object.assign(new Error(response.error ?? 'Memory watch rejected'), { native_rejected: true });
    const result = memoryWatchState.parse(response);
    if (result.watch_id !== id || result.session !== expected.session || result.execution_epoch !== expected.execution_epoch ||
        result.elf !== expected.elf || Number(result.elf_crc) !== Number(expected.elf_crc) || result.state !== 'armed' ||
        (o.cpu === 'iop' && result.iop_reset_epoch !== expected.iop_reset_epoch) || result.cpu !== o.cpu || result.address !== o.address ||
        result.size !== o.size || Number(result.mask) !== (o.mask ?? 2 ** (o.size * 8) - 1) ||
        result.sample_interval_ms !== o.sample_interval_ms || result.timeout_ms !== o.timeout_ms || result.pause_on_change !== o.pause_on_change)
      throw new Error('Unexpected memory watch identity/criterion');
    return result;
  }

  async memoryWatchStatus(id: string, cancel = false) {
    watchId.parse(id);
    const result = memoryWatchState.parse(await this.sessionCommand({ cmd: cancel ? 'memory_watch_cancel' : 'memory_watch_status', watch_id: id }));
    if (result.watch_id !== id) throw new Error('Unexpected memory watch ID');
    return result;
  }

  async listMemoryWatches() {
    return memoryWatchList.parse(await this.sessionCommand({ cmd: 'memory_watch_list' }));
  }

  async startIopLoadWatch(id: string, expected: StepIdentity & { iop_reset_epoch: number }, input: { path: string; sha256: string; size: number; prefix: string; timeout_ms: number }) {
    watchId.parse(id);
    const response = await this.send({ cmd: 'iop_load_start', watch_id: id, ...input,
      expected_iop_lifetime_epoch: expected.iop_lifetime_epoch,
      expected_process_id: expected.process_id, expected_session: expected.session, expected_execution_epoch: expected.execution_epoch,
      expected_iop_reset_epoch: expected.iop_reset_epoch, expected_elf: expected.elf, expected_elf_crc: expected.elf_crc });
    if (!response.ok) throw Object.assign(new Error(response.error ?? 'IOP load watch rejected'), { native_rejected: true });
    const result = loadState.parse(response);
    if (result.watch_id !== id || result.state !== 'armed' || result.session !== expected.session || result.execution_epoch !== expected.execution_epoch ||
        result.iop_lifetime_epoch !== expected.iop_lifetime_epoch ||
        result.iop_reset_epoch !== expected.iop_reset_epoch || result.elf !== expected.elf || result.elf_crc !== expected.elf_crc ||
        result.expected_sha256 !== input.sha256 || result.size !== input.size || result.path.replaceAll('\\', '/') !== input.path.replaceAll('\\', '/'))
      throw new Error('Unexpected IOP load watch identity/artifact');
    return result;
  }

  async iopLoadWatchStatus(id: string, cancel = false) {
    watchId.parse(id);
    const result = loadState.parse(await this.sessionCommand({ cmd: cancel ? 'iop_load_cancel' : 'iop_load_status', watch_id: id }));
    if (result.watch_id !== id) throw new Error('Unexpected IOP load watch ID');
    return result;
  }

  async startProgressWatch(id: string, expected: StepIdentity, options: z.input<typeof progressOptions>) {
    watchId.parse(id); const o = progressOptions.parse(options);
    const response = await this.send({ cmd: 'progress_watch_start', watch_id: id, ...o,
      expected_process_id: expected.process_id, expected_session: expected.session, expected_execution_epoch: expected.execution_epoch,
      expected_elf: expected.elf, expected_elf_crc: expected.elf_crc });
    if (!response.ok) throw Object.assign(new Error(response.error ?? 'Progress watch rejected'), { native_rejected: true });
    const result = progressState.parse(response), c = result.criterion;
    if (result.watch_id !== id || result.session !== expected.session || result.execution_epoch !== expected.execution_epoch ||
        result.elf !== expected.elf || Number(result.elf_crc) !== Number(expected.elf_crc) || result.state !== 'armed' ||
        c.heartbeat_address !== o.heartbeat_address || Number(c.heartbeat_mask) !== o.heartbeat_mask || c.active_address !== (o.active_address ?? null) ||
        Number(c.active_mask) !== o.active_mask || Number(c.active_value) !== o.active_value || c.sample_interval_ms !== o.sample_interval_ms ||
        c.stall_ms !== o.stall_ms || c.max_samples !== o.max_samples) throw new Error('Unexpected progress watch identity/criterion');
    return result;
  }

  async progressWatchStatus(id: string, cancel = false) {
    watchId.parse(id);
    const result = progressState.parse(await this.sessionCommand({ cmd: cancel ? 'progress_watch_cancel' : 'progress_watch_status', watch_id: id }));
    if (result.watch_id !== id) throw new Error('Unexpected progress watch ID');
    return result;
  }

  async startExceptionWatch(id: string, expected: StepIdentity & { iop_reset_epoch?: number }, options: z.input<typeof exceptionOptions>) {
    watchId.parse(id); const parsed = exceptionOptions.parse(options);
    const response = await this.send({ cmd: 'exception_watch_start', cpu: parsed.cpu, watch_id: id,
      expected_iop_lifetime_epoch: expected.iop_lifetime_epoch,
      exception_mask: [...new Set(parsed.exception_codes)].reduce((mask, code) => mask + 2 ** code, 0), timeout_ms: parsed.timeout_ms, screenshot: parsed.screenshot,
      expected_process_id: expected.process_id, expected_session: expected.session, expected_execution_epoch: expected.execution_epoch,
      expected_elf: expected.elf, expected_elf_crc: expected.elf_crc, expected_iop_reset_epoch: expected.iop_reset_epoch });
    if (!response.ok) throw Object.assign(new Error(response.error ?? 'Exception watch rejected'), { native_rejected: true });
    const result = exceptionState.parse(response);
    if (result.watch_id !== id || result.session !== expected.session || result.execution_epoch !== expected.execution_epoch || result.elf !== expected.elf ||
      Number(result.elf_crc) !== Number(expected.elf_crc) || result.state !== 'armed' || !result.active || result.report !== null || result.cpu !== parsed.cpu ||
      (parsed.cpu === 'iop' && (result.iop_reset_epoch === undefined || result.iop_reset_epoch !== expected.iop_reset_epoch || result.iop_reset_scope !== 'cpu_reset_only'))) throw new Error('Unexpected exception watch identity/state');
    return result;
  }

  async exceptionWatchStatus(id: string, cancel = false) {
    watchId.parse(id);
    const result = exceptionState.parse(await this.sessionCommand({ cmd: cancel ? 'exception_watch_cancel' : 'exception_watch_status', watch_id: id }));
    if (result.watch_id !== id || result.active !== ['armed', 'capturing'].includes(result.state) || (result.state === 'captured' && result.report === null) ||
      (result.state !== 'captured' && result.report !== null) ||
      (result.cpu === 'iop' && (result.iop_reset_epoch === undefined || result.iop_reset_scope !== 'cpu_reset_only'))) throw new Error('Inconsistent exception watch state');
    return result;
  }

  async guardedStepStatus(operationId: number, cancel = false) {
    z.number().int().positive().safe().parse(operationId);
    const result = guardedStepResponse.parse(await this.sessionCommand({ cmd: cancel ? 'guarded_step_cancel' : 'guarded_step_status', operation_id: operationId }));
    if (result.operation_id !== operationId) throw new Error('Unexpected guarded step operation ID');
    return result;
  }

  async removeSourceBreakpoints(groupId: string) {
    if (!/^[\da-f]{32}$/.test(groupId)) throw new Error('Invalid source breakpoint group ID');
    const response = await this.send({ cmd: 'remove_source_breakpoints', cpu: 'ee', group_id: groupId });
    if (!response.ok) throw new Error(response.error ?? 'Source breakpoint removal failed');
    const parsed = z.object({ ok: z.literal(true), group_id: z.string(), complete: z.boolean(),
      removed_addresses: z.array(address).max(64), preserved_addresses: z.array(address).max(64) }).parse(response);
    if (parsed.group_id !== groupId || parsed.complete !== (parsed.preserved_addresses.length === 0)) throw new Error('Unexpected native source breakpoint cleanup response');
    return parsed;
  }

  async lookupSymbols(options: SymbolOptions = {}) {
    return symbolsResponse.parse(await this.sessionCommand({ cmd: 'lookup_symbols', ...symbolOptions.parse(options) }));
  }

  async importSymbols() {
    return z.object({ ok: z.literal(true), requested: z.literal(true), session: z.number().int(), elf: z.string(), elf_crc: address })
      .parse(await this.sessionCommand({ cmd: 'import_symbols', cpu: 'ee' }));
  }

  async readMemoryStrict(value: string, length: number, cpu: CpuTarget = 'ee') {
    address.parse(value);
    z.number().int().min(1).max(4096).parse(length);
    const response = z.object({ ok: z.literal(true), hex: z.string().regex(/^(?:[\da-fA-F]{2})+$/), invalid_bytes: z.literal(0) })
      .parse(await this.sessionCommand({ cmd: 'read_memory', address: '0x' + value.replace(/^0x/, ''), length, cpu, strict: true }));
    if (response.hex.length !== length * 2) throw new Error('Strict memory read returned an unexpected byte count');
    return response.hex;
  }

  async sifSnapshot(expected: SifIdentity) {
    return parseSifSnapshot(await this.sessionCommand({ cmd: 'sif_snapshot', expected_process_id: expected.process_id,
      expected_session: expected.session, expected_execution_epoch: expected.execution_epoch,
      expected_iop_reset_epoch: expected.iop_reset_epoch, expected_iop_lifetime_epoch: expected.iop_lifetime_epoch,
      expected_elf: expected.elf, expected_elf_crc: expected.elf_crc }), expected);
  }

  async requestStateLoad(id: string, slot: number, expected: SifIdentity) {
    z.string().regex(/^[\da-f]{32}$/).parse(id); z.number().int().min(0).max(9).parse(slot);
    const response = await this.send({ cmd: 'state_load', operation_id: id, slot,
      expected_process_id: expected.process_id, expected_session: expected.session,
      expected_execution_epoch: expected.execution_epoch, expected_iop_reset_epoch: expected.iop_reset_epoch,
      expected_iop_lifetime_epoch: expected.iop_lifetime_epoch, expected_elf: expected.elf, expected_elf_crc: expected.elf_crc });
    if (!response.ok) throw Object.assign(new Error(response.error ?? 'State load not confirmed'), { native_refused: response.refused === true });
    return response;
  }

  async stateLoadReceipt(id: string) {
    z.string().regex(/^[\da-f]{32}$/).parse(id);
    return this.sessionCommand({ cmd: 'state_load_status', operation_id: id });
  }

  async resolveAddress(value: string, cpu: CpuTarget = 'ee') {
    address.parse(value);
    const result = resolvedResponse.parse(await this.sessionCommand({ cmd: 'resolve_address', address: '0x' + value.replace(/^0x/, ''), cpu }));
    const numeric = Number.parseInt(value.replace(/^0x/, ''), 16);
    return { ...result, symbols: result.symbols.map(symbol => ({ ...symbol, offset: numeric - Number.parseInt(symbol.address.replace(/^0x/, ''), 16) })) };
  }

  async setSymbolBreakpoint(name: string, cpu: CpuTarget = 'ee', temporary = false) {
    z.string().min(1).max(256).parse(name);
    return symbolBreakpointResponse.parse(await this.sessionCommand({ cmd: 'breakpoint_symbol', name, cpu, temporary }));
  }

  private async sessionCommand(command: Record<string, unknown>): Promise<any> {
    const response = await this.send(command);
    if (!response.ok) {
      const hint = typeof response.error === 'string' && response.error.startsWith('Unknown command')
        ? ' Rebuild PCSX2 with the updated DebugServer.' : '';
      throw new Error(`${response.error}${hint}`);
    }
    return response;
  }

  async startGsDump(id: string, expected: { process_id: number; session: number; execution_epoch: number; elf: string; elf_crc: string }, options: DumpOptions = {}) {
    watchId.parse(id);
    const input = dumpOptions.parse(options);
    const response = await this.send({ cmd: 'gs_dump_start', operation_id: id, ...input,
      expected_process_id: expected.process_id, expected_session: expected.session, expected_execution_epoch: expected.execution_epoch,
      expected_elf: expected.elf, expected_elf_crc: expected.elf_crc });
    if (!response.ok) throw Object.assign(new Error(response.error ?? 'GS dump start rejected'), { native_rejected: true });
    const result = parseDump(response, id);
    if (result.session !== expected.session || result.execution_epoch !== expected.execution_epoch || result.elf !== expected.elf ||
        Number(result.elf_crc) !== Number(expected.elf_crc) || result.frames_requested !== input.frames || result.max_bytes !== input.max_bytes)
      throw new Error('GS dump response identity/bounds do not match the request');
    return result;
  }

  async gsDumpStatus(id: string, cancel = false) {
    watchId.parse(id);
    return parseDump(await this.sessionCommand({ cmd: cancel ? 'gs_dump_cancel' : 'gs_dump_status', operation_id: id }), id);
  }

  async startMediaCapture(id: string, expected: { process_id: number; session: number; execution_epoch: number; elf: string; elf_crc: string }, options: MediaOptions = {}) {
    watchId.parse(id);
    const input = mediaOptions.parse(options);
    const response = await this.send({ cmd: 'media_start', operation_id: id, ...input,
      expected_process_id: expected.process_id, expected_session: expected.session, expected_execution_epoch: expected.execution_epoch,
      expected_elf: expected.elf, expected_elf_crc: expected.elf_crc });
    if (!response.ok) throw Object.assign(new Error(response.error ?? 'Media capture start rejected'), { native_rejected: true });
    const result = parseMedia(response, id);
    if (result.session !== expected.session || result.execution_epoch !== expected.execution_epoch || result.elf !== expected.elf ||
        Number(result.elf_crc) !== Number(expected.elf_crc) || result.max_frames !== input.frames || result.max_payload_bytes !== input.max_payload_bytes ||
        result.width !== input.width || result.height !== input.height || result.audio !== input.audio)
      throw new Error('Media capture response identity/bounds do not match the request');
    return result;
  }
  async mediaStatus(id: string, stop = false) {
    watchId.parse(id);
    return parseMedia(await this.sessionCommand({ cmd: stop ? 'media_stop' : 'media_status', operation_id: id }), id);
  }

  async startInputMovie(id: string, expected: { process_id: number; session: number; execution_epoch: number; elf: string; elf_crc: string },
    input: (MovieOptions | ReplayOptions) & { mode: 'record' | 'replay'; elf_sha256: string }) {
    watchId.parse(id);
    const response = await this.send({ cmd: 'input_movie_start', operation_id: id, ...input,
      expected_process_id: expected.process_id, expected_session: expected.session, expected_execution_epoch: expected.execution_epoch,
      expected_elf: expected.elf, expected_elf_crc: expected.elf_crc });
    if (!response.ok) throw Object.assign(new Error(response.error ?? 'Input movie rejected'), { native_rejected: true });
    const result = parseMovie(response, id);
    if (!result.active || !result.paused || result.frames !== 0 || result.mode !== input.mode || result.session !== expected.session ||
        result.execution_epoch !== expected.execution_epoch + 1 || result.elf !== expected.elf || Number(result.elf_crc) !== Number(expected.elf_crc) ||
        result.elf_sha256 !== input.elf_sha256 || (input.mode === 'record' && result.max_frames !== movieOptions.parse(input).frames) ||
        result.source !== ('path' in input ? input.path : '') || result.input_sha256 !== ('movie_sha256' in input ? input.movie_sha256 : ''))
      throw new Error('Input movie startup identity/state/bounds mismatch');
    return result;
  }

  async inputMovieStatus(id: string, stop = false) {
    watchId.parse(id);
    return parseMovie(await this.sessionCommand({ cmd: stop ? 'input_movie_stop' : 'input_movie_status', operation_id: id }), id);
  }

  async getCapabilities() {
    const result = capabilitiesResponse.parse(await this.sessionCommand({ cmd: 'capabilities' }));
    if (result.features.includes('iop_lifetime') && result.iop_lifetime_epoch === undefined) throw new Error('IOP lifetime capability missing epoch');
    return result;
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
    return this.withConnectionScope(async () => {
      if (this.automationOwner) throw new Error('A frame/input operation is already pending on this connection');
      const owner = { connection: this.requireConnection() }; this.automationOwner = owner;
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
      } finally { if (this.automationOwner === owner) this.automationOwner = undefined; }
    });
  }

  async readEvents(after = 0, limit = 100, waitMs = 0) {
    z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(after);
    z.number().int().min(1).max(200).parse(limit);
    z.number().int().min(0).max(1000).parse(waitMs);
    return eventsResponse.parse(await this.sessionCommand({ cmd: 'read_events', after, limit, wait_ms: waitMs }));
  }

  async waitEvent(options: { after?: number; type?: DebugEventType; timeoutMs?: number; signal?: AbortSignal } = {}) {
    options.signal?.throwIfAborted();
    return this.withConnectionScope(async () => {
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
    });
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

  /** Capture Qt widgets from this native process, independently of the GS frame. */
  async captureApplicationScreenshot(input: unknown = {}) {
    const options = applicationScreenshotOptions.parse(input);
    const response = await this.send({ cmd: 'application_screenshot', ...options });
    if (!response.ok) throw new Error('Application screenshot failed: ' + (response.error ?? 'Unknown error') +
      (/Unknown command/.test(response.error ?? '') ? '. Rebuild PCSX2 with Qt application capture support.' : ''));
    return parseApplicationScreenshot(response, options);
  }

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
  async step(cpu: CpuTarget = 'ee', timeoutMs = 1000, expected?: SifIdentity & { pc: string }): Promise<StepResult> {
    return this.instructionCommand('step', cpu, timeoutMs, expected);
  }

  /** Step over a JAL/JALR — effectively "next" */
  async stepOver(cpu: CpuTarget = 'ee', timeoutMs = 1000, expected?: SifIdentity & { pc: string }): Promise<StepResult> {
    return this.instructionCommand('step_over', cpu, timeoutMs, expected);
  }

  private async instructionCommand(cmd: 'step' | 'step_over', cpu: CpuTarget, timeoutMs: number, expected?: SifIdentity & { pc: string }): Promise<StepResult> {
    z.enum(['ee', 'iop']).parse(cpu); z.number().int().min(10).max(5000).parse(timeoutMs);
    const resp = await this.send({ cmd, cpu, timeout_ms: timeoutMs, ...(expected ? {
      expected_process_id: expected.process_id, expected_session: expected.session,
      expected_execution_epoch: expected.execution_epoch, expected_elf: expected.elf, expected_elf_crc: expected.elf_crc,
      expected_iop_reset_epoch: expected.iop_reset_epoch, expected_iop_lifetime_epoch: expected.iop_lifetime_epoch,
      expected_pc: expected.pc,
    } : {}) });
    if (!resp.ok) throw new Error(resp.error);
    return resp;
  }

  // ===== Thread/Module Info =====

  async getThreads(cpu: CpuTarget = 'ee'): Promise<ThreadInfo[]> {
    const resp = await this.send({ cmd: 'get_threads', cpu });
    if (!resp.ok) throw new Error(resp.error);
    return resp.threads;
  }

  async iopModuleSnapshot(expected: StepIdentity & { iop_reset_epoch: number }) {
    const result = parseIopModuleSnapshot(await this.sessionCommand({ cmd: 'iop_module_snapshot',
      expected_iop_lifetime_epoch: expected.iop_lifetime_epoch,
      expected_process_id: expected.process_id, expected_session: expected.session, expected_execution_epoch: expected.execution_epoch,
      expected_iop_reset_epoch: expected.iop_reset_epoch, expected_elf: expected.elf, expected_elf_crc: expected.elf_crc }));
    if (result.iop_lifetime_epoch !== expected.iop_lifetime_epoch || result.session !== expected.session || result.execution_epoch !== expected.execution_epoch || result.iop_reset_epoch !== expected.iop_reset_epoch ||
        result.elf !== expected.elf || Number(result.elf_crc) !== Number(expected.elf_crc)) throw new Error('IOP module snapshot identity mismatch');
    return result;
  }

  async iopModuleImage(expected: StepIdentity & { iop_reset_epoch: number; revision: number; registration_sequence?: number; registration_namespace?: string }, record: string) {
    address.parse(record);
    const result = parseIopModuleImage(await this.sessionCommand({ cmd: 'iop_module_image', module_record: record,
      expected_iop_lifetime_epoch: expected.iop_lifetime_epoch,
      expected_registration_sequence: expected.registration_sequence,
      expected_registration_namespace: expected.registration_namespace,
      expected_revision: expected.revision, expected_process_id: expected.process_id, expected_session: expected.session,
      expected_execution_epoch: expected.execution_epoch, expected_iop_reset_epoch: expected.iop_reset_epoch,
      expected_elf: expected.elf, expected_elf_crc: expected.elf_crc }));
    if (result.iop_lifetime_epoch !== expected.iop_lifetime_epoch || result.session !== expected.session || result.execution_epoch !== expected.execution_epoch || result.iop_reset_epoch !== expected.iop_reset_epoch ||
        (expected.registration_sequence !== undefined && result.module.observed_generation?.sequence !== expected.registration_sequence) ||
        (expected.registration_namespace !== undefined && result.module.observed_generation?.namespace !== expected.registration_namespace) ||
        result.revision !== expected.revision || result.image_record !== record || result.elf !== expected.elf || Number(result.elf_crc) !== Number(expected.elf_crc))
      throw new Error('IOP module image identity/revision mismatch');
    return result;
  }

  async iopLifetime() { return lifetimeResponse.parse(await this.sessionCommand({ cmd: 'iop_lifetime' })); }

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
