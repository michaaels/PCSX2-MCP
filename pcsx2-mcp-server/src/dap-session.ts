import path from 'node:path';
import { z } from 'zod';
import { DebugServerClient } from './debug-server-client.js';
import { SourceResolver, inspectSourceElf } from './source-debug.js';
import { SourceLineResolver, lineOptions, selectSourceFile } from './source-lines.js';
import { SourceVariables } from './source-variables.js';
import { SourceStepper } from './source-stepping.js';
import type { DapRequest } from './dap-wire.js';

const attachOptions = z.object({ port: z.number().int().min(1).max(65535), host: z.literal('127.0.0.1').optional(),
  elf: z.string().min(1).max(4096).refine(path.isAbsolute, 'elf must be an absolute local path'),
  expectedSha256: z.string().regex(/^[\da-fA-F]{64}$/).optional(),
  pathMappings: lineOptions.shape.path_mappings.default([]),
  stopOnAttach: z.boolean().default(true),
});
type Snapshot = Awaited<ReturnType<DebugServerClient['inspectEE']>>;
type Identity = Parameters<DebugServerClient['inspectEE']>[0];
type Value = { name: string; value?: string; type?: string; status?: string; address?: string; children?: Value[]; truncated?: boolean };
type Handle = { snapshot: Snapshot; identity: Identity; kind: 'frame' | 'registers' | 'locals' | 'values'; index: number; pc: string; values?: Value[] };
type Send = (message: Record<string, unknown>) => void;

/** One attached EE session. All requests and polls are serialized by the stdio host. */
export class Pcsx2DapSession {
  private seq = 1;
  private nextHandle = 1;
  private initialized = false;
  private configured = false;
  private client?: DebugServerClient;
  private options?: z.infer<typeof attachOptions>;
  private sha?: string;
  private identity?: Identity;
  private paused?: boolean;
  private lineBase = 1;
  private columnBase = 1;
  private handles = new Map<number, Handle>();
  private groups = new Map<string, string[]>();
  private source = new SourceResolver();
  private lines = new SourceLineResolver();
  private locals = new SourceVariables();
  private stepper = new SourceStepper();
  private ended = false;
  private eventCursor = 0;
  constructor(private send: Send, backends: { source?: SourceResolver; lines?: SourceLineResolver; locals?: SourceVariables; stepper?: SourceStepper } = {}) {
    if (backends.source) this.source = backends.source;
    if (backends.lines) this.lines = backends.lines;
    if (backends.locals) this.locals = backends.locals;
    if (backends.stepper) this.stepper = backends.stepper;
  }
  private event(event: string, body: unknown = {}) { this.send({ seq: this.seq++, type: 'event', event, body }); }
  private output(message: string) { this.event('output', { category: 'console', output: message + '\n' }); }
  private invalidate() { this.handles.clear(); }
  private handle(value: Handle) {
    if (this.handles.size >= 2048 || this.nextHandle >= 2147483647) throw new Error('DAP stop reference budget exceeded');
    const id = this.nextHandle++; this.handles.set(id, value); return id;
  }
  private async reference(id: number, kind?: Handle['kind']) {
    const ref = this.handles.get(id);
    if (!ref || kind && ref.kind !== kind) throw new Error('Expired or invalid stopped-state reference');
    const current = await this.client!.inspectEE(ref.identity, { revision: ref.snapshot.revision, pc: ref.snapshot.pc });
    if (current.gpr.some((value, i) => value !== ref.snapshot.gpr[i])) throw new Error('EE registers changed; stopped-state reference expired');
    return ref;
  }
  private async stoppedSnapshot() {
    if (!this.client || !this.options || !this.identity) throw new Error('Attach to PCSX2 first');
    const caps = await this.client.getCapabilities();
    for (const key of ['process_id', 'session', 'elf', 'elf_crc'] as const)
      if (caps[key] !== this.identity[key]) throw new Error('Attached VM identity changed; disconnect and attach again');
    const identity = { ...this.identity, execution_epoch: caps.execution_epoch! };
    const snapshot = await this.client.inspectEE(identity);
    return { identity, snapshot };
  }
  private stopped(reason: string, description?: string) {
    this.paused = true; this.invalidate();
    this.event('stopped', { reason, threadId: 1, allThreadsStopped: true, ...(description ? { description } : {}) });
  }
  private mapped(file: string) { return selectSourceFile([file], file, this.options!.pathMappings).mapped; }
  private async recentEvents() {
    let events: Awaited<ReturnType<DebugServerClient['readEvents']>>['events'] = [], dropped = false;
    for (let page = 0; page < 16; page++) {
      const history = await this.client!.readEvents(this.eventCursor, 200);
      this.eventCursor = history.next_cursor; dropped ||= history.dropped;
      events = [...events, ...history.events].slice(-64);
      if (history.events.length < 200) return { events, dropped };
    }
    throw new Error('Native event history exceeded DAP drain budget');
  }
  async poll() {
    if (!this.client || !this.configured || this.ended) return;
    try {
      const caps = await this.client.getCapabilities(), status = await this.client.getStatus();
      for (const key of ['process_id', 'session', 'elf', 'elf_crc'] as const)
        if (caps[key] !== this.identity![key]) throw new Error('Attached VM identity changed; reconnect explicitly');
      if (caps.execution_epoch !== this.identity!.execution_epoch) {
        this.invalidate(); this.identity = { ...this.identity!, execution_epoch: caps.execution_epoch! };
        this.output('VM execution epoch changed; prior frame/variable references are invalid.');
      }
      if (status.paused && this.paused === false) {
        const history = await this.recentEvents();
        const cause = !history.dropped && [...history.events].reverse().find(e =>
          e.type === 'breakpoint' && e.cpu === 'ee' && e.pc === status.pc || e.type === 'ee_exception' || e.type === 'iop_exception');
        this.stopped(cause ? cause.type === 'breakpoint' ? 'breakpoint' : 'exception' : 'pause',
          cause ? `${cause.cpu}: ${cause.type} ${cause.detail.slice(0, 1024)}` : 'VM paused; stop cause unavailable.');
      }
      else if (!status.paused && this.paused === true) { this.invalidate(); this.paused = false; this.event('continued', { threadId: 1, allThreadsContinued: true }); }
    } catch (error) {
      this.invalidate(); this.output('Debug observation failed: ' + String(error));
      const pending = [...this.groups.values()].flat();
      if (pending.length) this.output('Old source groups left untouched; cleanup unconfirmed: ' + pending.join(', '));
      this.client.disconnect(); this.client = undefined; this.event('terminated'); this.ended = true;
    }
  }
  async request(request: DapRequest) {
    try {
      const body = await this.dispatch(request.command, request.arguments ?? {});
      this.send({ seq: this.seq++, type: 'response', request_seq: request.seq, command: request.command, success: true, body });
      // Configuration requests must be possible only after attach is prepared.
      if (request.command === 'attach') this.event('initialized');
      if (request.command === 'configurationDone' && this.paused) this.stopped('entry');
      if (request.command === 'disconnect') { this.event('terminated'); this.ended = true; }
    } catch (error) {
      this.send({ seq: this.seq++, type: 'response', request_seq: request.seq, command: request.command,
        success: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
  private async dispatch(command: string, args: Record<string, unknown>): Promise<unknown> {
    if (command === 'initialize') {
      if (this.initialized) throw new Error('Already initialized');
      const input = z.object({ pathFormat: z.literal('path').optional(), linesStartAt1: z.boolean().default(true),
        columnsStartAt1: z.boolean().default(true) }).parse(args);
      this.lineBase = input.linesStartAt1 ? 1 : 0; this.columnBase = input.columnsStartAt1 ? 1 : 0;
      this.initialized = true;
      return { supportsConfigurationDoneRequest: true, supportsReadMemoryRequest: true,
        supportsSteppingGranularity: true, supportsTerminateRequest: false,
        supportsSetVariable: false, supportsWriteMemoryRequest: false, supportsEvaluateForHovers: false,
        supportsConditionalBreakpoints: false, supportsHitConditionalBreakpoints: false, supportsLogPoints: false,
        supportsRestartRequest: false, supportsStepBack: false };
    }
    if (!this.initialized) throw new Error('Initialize a new DAP session first');
    if (command === 'disconnect') {
      if (args.terminateDebuggee === true) throw new Error('Attached emulator termination is unsupported');
      await this.dispose(); return {};
    }
    if (this.ended) throw new Error('Initialize a new DAP session first');
    if (command === 'attach') {
      if (this.client) throw new Error('Already attached');
      const options = attachOptions.parse(args), elf = await inspectSourceElf(options.elf);
      if (options.expectedSha256 && elf.sha256 !== options.expectedSha256.toLowerCase()) throw new Error('ELF SHA256 mismatch');
      const client = new DebugServerClient('127.0.0.1', options.port);
      try {
        await client.connect(); const caps = await client.getCapabilities();
        const loaded = caps.elf.replace(/^host:/, '');
        // The backend's source installer uses canonical path and CRC checks as well.
        const loadedElf = path.isAbsolute(loaded) ? await inspectSourceElf(loaded) : null;
        if (!loadedElf || loadedElf.elf !== elf.elf || caps.elf_crc !== elf.elf_crc) throw new Error('Loaded local ELF/path/CRC mismatch');
        for (const feature of ['source_breakpoints', 'variable_inspection', 'guarded_step'])
          if (!caps.features.includes(feature)) throw new Error('Native capability required: ' + feature);
        if (caps.process_id === undefined || caps.execution_epoch === undefined) throw new Error('Native identity unavailable');
        // Validate mapping uniqueness and syntax without guessing source paths.
        lineOptions.parse({ elf: elf.elf, file: elf.elf, line: 1, path_mappings: options.pathMappings });
        selectSourceFile([elf.elf], elf.elf, options.pathMappings);
        const status = await client.getStatus(); if (options.stopOnAttach && !status.paused) await client.pause();
        this.client = client; this.options = { ...options, elf: elf.elf }; this.sha = elf.sha256;
        this.identity = { process_id: caps.process_id, session: caps.session, elf: caps.elf, elf_crc: caps.elf_crc, execution_epoch: caps.execution_epoch };
        this.paused = (await client.getStatus()).paused;
        return {};
      } catch (error) { client.disconnect(); throw error; }
    }
    if (!this.client) throw new Error('Attach to PCSX2 first');
    if (command === 'configurationDone') { this.configured = true; return {}; }
    if (command === 'threads') return { threads: [{ id: 1, name: 'R5900 (EE CPU)' }] };
    if (command === 'setExceptionBreakpoints') {
      if (!Array.isArray(args.filters) || args.filters.length) throw new Error('DAP exception filters are unsupported'); return {};
    }
    if (command === 'pause') {
      this.thread(args); await this.client.pause(); this.stopped('pause'); return {};
    }
    if (command === 'continue') {
      this.thread(args); await this.stoppedSnapshot(); await this.recentEvents(); this.invalidate();
      await this.client.resume(); this.paused = false; this.event('continued', { threadId: 1, allThreadsContinued: true });
      return { allThreadsContinued: true };
    }
    if (['next', 'stepIn', 'stepOut'].includes(command)) {
      this.thread(args); await this.stoppedSnapshot(); this.invalidate();
      let result: { completed?: boolean; reason?: string; cleanup_complete?: boolean };
      try {
        if (args.granularity === 'instruction') {
          if (command === 'stepOut') throw new Error('Instruction step-out is unsupported; use source step-out');
          if (command === 'next') await this.client.stepOver('ee', 1000); else await this.client.step('ee', 1000);
          result = { completed: true };
        } else {
          if (args.granularity !== undefined && args.granularity !== 'line' && args.granularity !== 'statement') throw new Error('Unsupported stepping granularity');
          result = await this.stepper.run(this.client, { mode: command === 'next' ? 'over' : command === 'stepOut' ? 'out' : 'into',
            expected_sha256: this.sha, timeout_ms: 5000, max_instruction_units: 512 });
        }
      } finally {
        if ((await this.client.getStatus()).paused) this.stopped('step');
      }
      if (!result.completed) throw new Error('Step incomplete: ' + result.reason);
      return {};
    }
    if (command === 'setBreakpoints') {
      await this.stoppedSnapshot();
      const input = z.object({ source: z.object({ path: z.string().min(1).max(4096) }),
        breakpoints: z.array(z.object({ line: z.number().int().min(this.lineBase), condition: z.string().optional(),
          hitCondition: z.string().optional(), logMessage: z.string().optional(), column: z.number().int().optional() })).max(64).default([]) }).parse(args);
      const file = input.source.path, old = this.groups.get(file) ?? [];
      for (const id of [...old]) {
        const result = await this.client.removeSourceBreakpoints(id);
        if (!result.complete) throw new Error('Source breakpoint changed ownership; preserved, replacement refused');
        old.splice(old.indexOf(id), 1);
      }
      this.groups.set(file, old); const breakpoints = [];
      for (const bp of input.breakpoints) {
        if (bp.condition !== undefined || bp.hitCondition !== undefined || bp.logMessage !== undefined || bp.column !== undefined) {
          breakpoints.push({ verified: false, line: bp.line, message: 'Only exact source line breakpoints are supported' }); continue;
        }
        try {
          const installed = await this.lines.install(this.client, { elf: this.options!.elf, file, line: bp.line + 1 - this.lineBase,
            path_mappings: this.options!.pathMappings, expected_sha256: this.sha });
          old.push(installed.group_id);
          breakpoints.push({ verified: true, line: bp.line, source: { path: file }, instructionReference: installed.addresses[0] });
        } catch (error) {
          if (error instanceof Error && 'group_id' in error && typeof error.group_id === 'string' &&
              (!('cleanup' in error) || (error.cleanup as { complete?: boolean })?.complete !== true)) old.push(error.group_id);
          breakpoints.push({ verified: false, line: bp.line, message: String(error) });
        }
      }
      return { breakpoints };
    }
    if (command === 'stackTrace') {
      this.thread(args); const input = z.object({ startFrame: z.number().int().min(0).max(63).default(0), levels: z.number().int().min(0).max(64).default(32) }).parse(args);
      const { identity, snapshot } = await this.stoppedSnapshot();
      const backtrace = await this.client.getBacktrace('ee', 64);
      const pcs = (backtrace[0]?.pc === snapshot.pc ? backtrace.map(f => f.pc) : [snapshot.pc, ...backtrace.map(f => f.pc)]).slice(0, 64);
      const resolved = await this.source.resolve({ elf: this.options!.elf, addresses: pcs, expected_sha256: this.sha }, undefined, identity.elf_crc);
      const verified = await this.client.inspectEE(identity, { revision: snapshot.revision, pc: snapshot.pc });
      if (verified.gpr.some((value, i) => value !== snapshot.gpr[i])) throw new Error('EE registers changed during stack lookup');
      const frames = pcs.slice(input.startFrame, input.startFrame + (input.levels || 64)).map((pc, i) => {
        const index = i + input.startFrame, line = resolved.locations.find(l => l.address === pc)?.frames[0];
        return { id: this.handle({ identity, snapshot, kind: 'frame', index, pc }), name: line?.function ?? pc,
          instructionPointerReference: pc, line: line?.line ? line.line - 1 + this.lineBase : 0,
          column: line?.column ? line.column - 1 + this.columnBase : 0,
          ...(line?.file ? { source: { name: path.basename(line.file), path: this.mapped(line.file) } } : {}) };
      });
      return { stackFrames: frames, totalFrames: pcs.length };
    }
    if (command === 'scopes') {
      const frame = await this.reference(z.number().int().positive().parse(args.frameId), 'frame');
      if (frame.index !== 0) return { scopes: [] }; // No reconstructed caller registers/locals.
      return { scopes: [
        { name: 'EE GPR', presentationHint: 'registers', variablesReference: this.handle({ ...frame, kind: 'registers' }), expensive: false },
        { name: 'Locals and arguments (frame 0)', presentationHint: 'locals', variablesReference: this.handle({ ...frame, kind: 'locals' }), expensive: true },
      ] };
    }
    if (command === 'variables') {
      const input = z.object({ variablesReference: z.number().int().positive(), start: z.number().int().min(0).max(256).default(0), count: z.number().int().min(0).max(256).default(0) }).parse(args);
      const ref = await this.reference(input.variablesReference); let values: Value[];
      if (ref.kind === 'registers') {
        const names = ['zero','at','v0','v1','a0','a1','a2','a3','t0','t1','t2','t3','t4','t5','t6','t7','s0','s1','s2','s3','s4','s5','s6','s7','t8','t9','k0','k1','gp','sp','fp','ra'];
        values = ref.snapshot.gpr.map((value, i) => ({ name: names[i], value, type: 'uint128' }));
        values.push({ name: 'pc', value: ref.snapshot.pc, type: 'uint32' });
      } else if (ref.kind === 'locals') {
        const result = await this.locals.inspect(this.client, { frame_index: 0, expected_sha256: this.sha });
        if (result.snapshot.revision !== ref.snapshot.revision || result.snapshot.pc !== ref.snapshot.pc) throw new Error('Stopped state changed during local inspection');
        values = result.variables;
        if (result.truncated) this.output('Locals truncated by backend bounds.');
      } else if (ref.kind === 'values') values = ref.values!;
      else throw new Error('Expected a variable scope reference');
      await this.reference(input.variablesReference);
      return { variables: values.slice(input.start, input.count ? input.start + input.count : undefined).map(v => ({
        name: v.name, value: v.value ?? `<${v.status ?? (v.children ? 'aggregate' : 'unavailable')}>`, type: v.type,
        variablesReference: v.children?.length ? this.handle({ ...ref, kind: 'values', values: v.children }) : 0,
        ...(v.address ? { memoryReference: v.address } : {}),
        ...(v.status && v.status !== 'available' ? { presentationHint: { attributes: ['readOnly'], visibility: 'internal' } } : {}),
      })) };
    }
    if (command === 'readMemory') {
      const input = z.object({ memoryReference: z.string().regex(/^0x[\da-fA-F]{1,8}$/),
        offset: z.number().int().min(-2147483648).max(2147483647).default(0), count: z.number().int().min(1).max(4096) }).parse(args);
      const address = Number(input.memoryReference) + input.offset;
      if (address < 0 || address + input.count > 32 * 1024 ** 2) throw new Error('Only canonical first-32-MiB EE RAM is readable');
      const { identity, snapshot } = await this.stoppedSnapshot(), hex = '0x' + address.toString(16).padStart(8, '0');
      const result = await this.client.inspectEE(identity, { revision: snapshot.revision, pc: snapshot.pc }, hex, input.count);
      if (result.gpr.some((value, i) => value !== snapshot.gpr[i])) throw new Error('EE registers changed during memory lookup');
      if (!result.memory?.valid) throw new Error('Memory unavailable: ' + result.memory?.reason);
      return { address: hex, data: Buffer.from(result.memory.hex!, 'hex').toString('base64'), unreadableBytes: 0 };
    }
    throw new Error('Unsupported DAP request: ' + command);
  }
  private thread(args: Record<string, unknown>) { if (args.threadId !== 1) throw new Error('Only EE CPU threadId=1 is supported'); }
  async dispose() {
    this.invalidate();
    if (!this.client) { this.groups.clear(); return; }
    const client = this.client;
    try {
      const before = await client.getCapabilities();
      for (const key of ['process_id', 'session', 'elf', 'elf_crc'] as const)
        if (before[key] !== this.identity![key]) { this.output('Detach left old breakpoint groups untouched: VM identity changed.'); return; }
      const running = !(await client.getStatus()).paused, hasGroups = [...this.groups.values()].some(ids => ids.length);
      if (hasGroups && running) await client.pause();
      const stopped = hasGroups ? await client.getStatus() : undefined;
      try {
        for (const ids of this.groups.values()) for (const id of ids) {
          try { const result = await client.removeSourceBreakpoints(id); if (!result.complete) this.output(`Detach preserved changed group ${id}.`); }
          catch (error) { this.output(`Detach cleanup unconfirmed for group ${id}: ` + String(error)); }
        }
      } finally {
        if (hasGroups && running) {
          const after = await client.getCapabilities(), state = await client.getStatus();
          if (['process_id', 'session', 'elf', 'elf_crc', 'execution_epoch'].every(key => before[key as keyof typeof before] === after[key as keyof typeof after]) &&
              state.paused && state.pc === stopped!.pc && state.cycles === stopped!.cycles) await client.resume();
          else this.output('Detach did not resume: sampled VM state changed during cleanup.');
        }
      }
    } finally { client.disconnect(); this.client = undefined; this.groups.clear(); }
  }
}
