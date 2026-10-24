import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DebugServerClient } from './debug-server-client.js';
import { eventTypes } from './debug-session.js';
import { inspectSourceElf } from './source-debug.js';

const count = z.number().int().nonnegative().safe(), u32 = count.max(0xffffffff);
const hexId = z.string().regex(/^[a-f0-9]{16}$/), sha = z.string().regex(/^[a-f0-9]{64}$/);
const crc = z.string().regex(/^0x[a-f0-9]{8}$/);
const localPath = z.string().min(1).max(4096).refine(p => path.isAbsolute(p) && !/[\x00-\x1f]/.test(p), 'Absolute local path required');
// Adapter for the current DiagnosticStore/UDPFS structured client-event contract.
// Free-form console, HTTP and process logs are deliberately never copied.
const clientEvents = ['boot', 'network_ready', 'network_lost', 'network_recovered', 'catalog_open', 'catalog_return',
  'catalog_refresh', 'prepare_requested', 'prepare_ready', 'prepare_failed', 'handoff_requested', 'handoff_failed',
  'client_error', 'media_open', 'media_open_failed', 'player_init_failed', 'player_enter', 'player_return',
  'update_check', 'update_download', 'update_ready', 'update_failed', 'update_rollback', 'update_launch',
  'update_healthy', 'update_path_failed', 'update_key_failed', 'update_skipped', 'update_deferred'] as const;
const eventName = z.enum(clientEvents), level = z.enum(['INFO', 'WARN', 'ERROR']);
const sessionId = z.string().regex(/^(?:[a-f0-9]{16}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/);
const diagnostic = z.object({ buildId: hexId, bootId: hexId, sequence: u32, event: eventName, uptimeMs: u32,
  dropped: u32, level, sessionId, deviceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  receivedAt: z.string().datetime({ offset: true }).refine(s => Number.isFinite(Date.parse(s))) }).strict();
const consoleEvent = z.object({ native_sequence: count, native_timestamp_ms: count, event: eventName, level,
  client_sequence: u32, client_session: sessionId }).strict();
const nativeEvent = z.object({ sequence: count, timestamp_ms: count, type: z.enum(eventTypes),
  cpu: z.enum(['ee', 'iop', 'unknown']), pc: crc.nullable() }).strict();
const build = z.object({ build_id: hexId, elf_sha256: sha, elf_crc: crc, manifest_sha256: sha }).strict();
const capture = z.object({ format_version: z.literal(1), kind: z.literal('pcsx2_project_capture'), capture_id: z.string().uuid(),
  build, identity: z.object({ process_id: count.positive(), session: count.positive(), execution_epoch: count.positive() }).strict(),
  collection: z.object({ started_ms: count, ended_ms: count, elapsed_monotonic_ms: z.number().nonnegative().finite() }).strict(),
  coverage: z.object({ events_dropped: z.boolean(), logs_dropped: z.boolean(), events_page_limit: z.boolean(), logs_page_limit: z.boolean(),
    event_cursor: count, log_cursor: count, discarded_console_messages: count, truncated_console_messages: count,
    per_entry_execution_epoch: z.literal('unavailable') }).strict(),
  events: z.array(nativeEvent).max(2200), client_logs: z.array(consoleEvent).max(2200) }).strict();
export const collectOptions = z.object({ manifest_path: localPath, elf_path: localPath, output_directory: localPath,
  pages: z.number().int().min(1).max(11).default(11), events_after: count.default(0), logs_after: count.default(0) });
export const correlateOptions = z.object({ manifest_path: localPath, elf_path: localPath, bridge_log_path: localPath,
  capture_path: localPath.optional(), capture_sha256: sha.optional(), boot_id: hexId, device_ref: sha.optional(), output_directory: localPath });
type Capture = z.infer<typeof capture>;
function valid<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const result = schema.safeParse(value); if (!result.success) throw new Error(`Invalid ${name} schema`); return result.data;
}
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function readBounded(filename: string, max: number, role: string, signal?: AbortSignal) {
  localPath.parse(filename); signal?.throwIfAborted();
  const file = await fs.open(filename, 'r').catch(() => { throw new Error(`Cannot open ${role}`); });
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(max)) throw new Error(`${role} exceeds file bounds`);
    const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted(); const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error(`${role} truncated during read`); offset += read.bytesRead;
    }
    const after = await file.stat({ bigint: true }), current = await fs.stat(filename, { bigint: true });
    for (const stat of [after, current]) for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const)
      if (stat[key] !== before[key]) throw new Error(`${role} changed during read; use a stable copy`);
    signal?.throwIfAborted(); return { bytes, sha256: hash(bytes), size_bytes: bytes.length };
  } finally { await file.close(); }
}
function json(bytes: Buffer, role: string): unknown {
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`Invalid JSON in ${role}`); }
}
async function project(manifestPath: string, elfPath: string, signal?: AbortSignal) {
  const manifest = await readBounded(manifestPath, 2 * 1024 * 1024, 'project manifest', signal);
  const parsed = valid(z.object({ format_version: z.literal(1), build_id: hexId, elf_sha256: sha, pcsx2_crc: crc }),
    json(manifest.bytes, 'project manifest'), 'project manifest');
  const elf = await inspectSourceElf(elfPath); signal?.throwIfAborted();
  if (elf.sha256 !== parsed.elf_sha256 || elf.elf_crc !== parsed.pcsx2_crc) throw new Error('Project manifest/ELF SHA256 or CRC mismatch');
  return { build_id: parsed.build_id, elf_sha256: elf.sha256, elf_crc: elf.elf_crc, manifest_sha256: manifest.sha256 };
}
async function save(value: unknown, directory: string, filename: string, signal?: AbortSignal) {
  signal?.throwIfAborted(); const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  if (bytes.length > 4 * 1024 * 1024) throw new Error('Diagnostic output exceeds 4 MiB');
  await fs.mkdir(directory, { recursive: true }); const folder = await fs.mkdtemp(path.join(directory, 'ps2-diagnostics-'));
  const target = path.join(folder, filename); await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  return { path: target, sha256: hash(bytes), size_bytes: bytes.length };
}

export function parseClientConsole(message: string, truncated: boolean) {
  if (truncated) return null;
  const match = /^JFCLIENT event=([a-z_]+) level=(INFO|WARN|ERROR) sequence=(\d{1,10}) session=([a-f0-9-]+)\r?\n?$/.exec(message);
  if (!match || !eventName.safeParse(match[1]).success || !sessionId.safeParse(match[4]).success || Number(match[3]) > 0xffffffff) return null;
  return { event: match[1] as typeof clientEvents[number], level: match[2] as z.infer<typeof level>,
    client_sequence: Number(match[3]), client_session: match[4] };
}

export async function collectProjectDiagnostics(client: DebugServerClient, input: z.input<typeof collectOptions>, signal?: AbortSignal) {
  const options = collectOptions.parse(input), artifact = await project(options.manifest_path, options.elf_path, signal);
  return client.withExclusiveSession(async () => {
    const started = Date.now(), monotonic = performance.now(), before = await client.getCapabilities();
    if (!before.features.includes('events') || !before.features.includes('console_logs') || before.process_id === undefined || before.execution_epoch === undefined)
      throw new Error('Native event/log and process/session/epoch capabilities are required');
    const loaded = before.elf.startsWith('host:') ? before.elf.slice(5) : before.elf;
    if (!path.isAbsolute(loaded)) throw new Error('Boot a local project ELF before collecting diagnostics');
    const samePath = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
    if (samePath(await fs.realpath(loaded)) !== samePath(await fs.realpath(options.elf_path)) || before.elf_crc !== artifact.elf_crc)
      throw new Error('Loaded ELF path/CRC differs from the selected project artifact');
    const events: Capture['events'] = [], logs: Capture['client_logs'] = [];
    let discarded = 0, truncated = 0;
    async function pages(kind: 'events' | 'logs', initial: number) {
      let cursor = initial, dropped = false, limited = false;
      for (let page = 0; page < options.pages; ++page) {
        signal?.throwIfAborted(); const response = kind === 'events' ? await client.readEvents(cursor, 200) : await client.readLogs(cursor, 200);
        if (response.session !== before.session) throw new Error('Native history session changed');
        const entries = 'events' in response ? response.events : response.logs;
        for (const entry of entries) {
          if (entry.sequence <= cursor) throw new Error('Native history cursor is not strictly increasing');
          cursor = entry.sequence;
          if ('type' in entry) events.push({ sequence: entry.sequence, timestamp_ms: entry.timestamp_ms, type: entry.type,
            cpu: entry.cpu === 'ee' || entry.cpu === 'iop' ? entry.cpu : 'unknown', pc: crc.safeParse(entry.pc).success ? entry.pc : null });
          else {
            if (entry.truncated) ++truncated;
            const parsed = entry.source === 'console' ? parseClientConsole(entry.message, entry.truncated) : null;
            if (parsed) logs.push({ native_sequence: entry.sequence, native_timestamp_ms: entry.timestamp_ms, ...parsed }); else ++discarded;
          }
        }
        if (response.next_cursor !== cursor) throw new Error('Native history next cursor disagrees with entries');
        dropped ||= response.dropped;
        limited = entries.length === 200;
        if (!limited) break;
      }
      return { cursor, dropped, limited };
    }
    const ev = await pages('events', options.events_after), log = await pages('logs', options.logs_after);
    const after = await client.getCapabilities();
    for (const field of ['process_id', 'session', 'execution_epoch', 'elf', 'elf_crc'] as const)
      if (before[field] !== after[field]) throw new Error('VM/ELF identity changed during diagnostic collection');
    if (JSON.stringify(await project(options.manifest_path, options.elf_path, signal)) !== JSON.stringify(artifact))
      throw new Error('Project artifact changed during diagnostic collection');
    const result = valid(capture, { format_version: 1, kind: 'pcsx2_project_capture', capture_id: randomUUID(), build: artifact,
      identity: { process_id: before.process_id, session: before.session, execution_epoch: before.execution_epoch },
      collection: { started_ms: started, ended_ms: Date.now(), elapsed_monotonic_ms: performance.now() - monotonic },
      coverage: { events_dropped: ev.dropped, logs_dropped: log.dropped, events_page_limit: ev.limited, logs_page_limit: log.limited,
        event_cursor: ev.cursor, log_cursor: log.cursor, discarded_console_messages: discarded, truncated_console_messages: truncated,
        per_entry_execution_epoch: 'unavailable' }, events, client_logs: logs }, 'capture');
    const file = await save(result, options.output_directory, 'capture.json', signal);
    return { artifact: file, build: artifact, identity: result.identity, coverage: result.coverage,
      observed_boot_ids: [...new Set(logs.filter(l => l.event === 'boot' && hexId.safeParse(l.client_session).success).map(l => l.client_session))],
      events: events.length, client_log_entries: logs.length, guest_state_changed_by_tool: false };
  });
}

export function correlateStreams(native: Capture | null, rows: z.infer<typeof diagnostic>[], selectedBuild: z.infer<typeof build>, bootId: string, device?: string) {
  const selected = rows.map((row, line) => ({ ...row, receipt_line: line + 1, device_ref: hash(row.deviceId) }))
    .filter(row => row.buildId === selectedBuild.build_id && row.bootId === bootId && (!device || row.device_ref === device));
  const devices = [...new Set(selected.map(row => row.device_ref))];
  if (devices.length > 1) throw new Error('Multiple devices share this build/boot; select device_ref explicitly');
  const bySequence = new Map<number, (typeof selected)[number] & { duplicate_receipts: number }>();
  for (const row of selected) {
    const previous = bySequence.get(row.sequence);
    if (previous) {
      for (const key of ['event', 'level', 'sessionId', 'uptimeMs', 'dropped'] as const)
        if (previous[key] !== row[key]) throw new Error('Conflicting client events reuse one sequence in the selected build/boot/device');
      ++previous.duplicate_receipts;
    } else bySequence.set(row.sequence, { ...row, duplicate_receipts: 0 });
  }
  const client = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
  const logs = native?.client_logs ?? [], anchors = logs.filter(l => l.event === 'boot' && l.client_session === bootId);
  const anchor = anchors.length === 1 ? anchors[0] : null;
  const nextBoot = anchor ? logs.find(l => l.event === 'boot' && l.native_sequence > anchor.native_sequence)?.native_sequence ?? Infinity : 0;
  const segment = anchor ? logs.filter(l => l.native_sequence >= anchor.native_sequence && l.native_sequence < nextBoot) : [];
  let missing = client[0]?.sequence ?? 0, uptimeRegressions = 0;
  const events = client.map((row, index) => {
    const previous = client[index - 1];
    if (previous) { missing += row.sequence - previous.sequence - 1; if (row.uptimeMs < previous.uptimeMs) ++uptimeRegressions; }
    const matches = segment.filter(l => l.client_sequence === row.sequence && l.event === row.event && l.level === row.level && l.client_session === row.sessionId);
    const association = !anchor ? 'boot_anchor_unavailable_or_ambiguous' : matches.length === 1 ? 'matching_reported_fields' : matches.length > 1 ? 'ambiguous_console_matches' : 'not_observed_in_console';
    return { sequence: row.sequence, event: row.event, level: row.level, client_session_id: row.sessionId,
      uptime_ms: row.uptimeMs, since_previous_client_event_ms: previous && row.uptimeMs >= previous.uptimeMs ? row.uptimeMs - previous.uptimeMs : null,
      dropped_reported: row.dropped, bridge_received_at: row.receivedAt, receipt_line: row.receipt_line,
      duplicate_receipts: row.duplicate_receipts, association,
      native_log_sequence: matches.length === 1 ? matches[0].native_sequence : null,
      native_timestamp_ms: matches.length === 1 ? matches[0].native_timestamp_ms : null };
  });
  return { client: { build_id: selectedBuild.build_id, boot_id: bootId, device_ref: devices[0] ?? device ?? null,
      selected_receipts: selected.length, unique_events: events.length, missing_sequence_count: missing,
      uptime_regressions_or_wraps: uptimeRegressions, events },
    association: { basis: 'reported_build_boot_and_console_boot_segment_session_sequence_event_level',
      console_boot_anchor_count: anchors.length, matched_events: events.filter(e => e.association === 'matching_reported_fields').length,
      native_history_scope: 'session_only_per_entry_ELF_and_epoch_unavailable', authenticated: false },
    clocks: { client: 'reported_uint32_uptime_ms', bridge: 'receipt_wall_time', native: 'native_wall_time',
      cross_process_offset_ms: null, cross_process_uncertainty_ms: null, uncertainty: 'unbounded',
      reason: 'no_shared_clock_calibration_or_bounded_delivery_delay', merged_timeline: 'not_constructed', transport_latency_ms: null } };
}

export async function correlateProjectDiagnostics(input: z.input<typeof correlateOptions>, signal?: AbortSignal) {
  const options = correlateOptions.parse(input);
  if (!!options.capture_path !== !!options.capture_sha256) throw new Error('Supply capture_path and capture_sha256 together, or omit both');
  const artifact = await project(options.manifest_path, options.elf_path, signal);
  const source = await readBounded(options.bridge_log_path, 2 * 1024 * 1024, 'Bridge diagnostic JSONL', signal);
  const lines = source.bytes.toString('utf8').split(/\r?\n/); if (lines.at(-1) === '') lines.pop();
  if (lines.length > 4096 || lines.some(line => Buffer.byteLength(line) > 2048)) throw new Error('Bridge diagnostic line/count bounds exceeded');
  const rows = lines.map(line => valid(diagnostic, json(Buffer.from(line), 'Bridge diagnostic JSONL'), 'Bridge diagnostic'));
  let native: Capture | null = null, nativeSHA: string | null = null;
  if (options.capture_path) {
    const source = await readBounded(options.capture_path, 2 * 1024 * 1024, 'native capture', signal);
    if (source.sha256 !== options.capture_sha256) throw new Error('Native capture SHA256 differs from the supplied receipt');
    native = valid(capture, json(source.bytes, 'native capture'), 'native capture'); nativeSHA = source.sha256;
    if (JSON.stringify(native.build) !== JSON.stringify(artifact)) throw new Error('Native capture belongs to a different manifest/ELF build');
    for (const stream of [native.events.map(e => e.sequence), native.client_logs.map(e => e.native_sequence)])
      if (stream.some((sequence, i) => i > 0 && sequence <= stream[i - 1])) throw new Error('Imported native stream order is invalid');
  }
  const streams = correlateStreams(native, rows, artifact, options.boot_id, options.device_ref);
  const partialReasons: string[] = [];
  if (!native) partialReasons.push('native_capture_not_supplied');
  if (!streams.client.unique_events) partialReasons.push('selected_bridge_events_not_observed');
  if (streams.association.matched_events !== streams.client.unique_events) partialReasons.push('some_client_events_not_uniquely_associated');
  if (streams.association.console_boot_anchor_count !== 1) partialReasons.push('console_boot_anchor_unavailable_or_ambiguous');
  if (streams.client.missing_sequence_count) partialReasons.push('client_sequence_gaps');
  if (streams.client.uptime_regressions_or_wraps) partialReasons.push('client_uptime_regression_or_wrap');
  if (streams.client.events.some(e => e.dropped_reported > 0)) partialReasons.push('client_reported_drops');
  if (native?.coverage.events_dropped || native?.coverage.logs_dropped) partialReasons.push('native_history_overwritten');
  if (native?.coverage.events_page_limit || native?.coverage.logs_page_limit) partialReasons.push('native_page_limit_reached');
  if (native?.coverage.truncated_console_messages) partialReasons.push('native_console_messages_truncated');
  const result = { format_version: 1, kind: 'ps2_project_correlation', build: artifact,
    evidence: { bridge_jsonl_sha256: source.sha256, bridge_jsonl_bytes: source.size_bytes, native_capture_sha256: nativeSHA,
      native_capture_provenance: native ? 'imported_unsigned_capture' : 'not_supplied', total_bridge_receipts: rows.length },
    ...streams, coverage: { partial_reasons: partialReasons, whole_session_coverage: 'not_established' },
    native: native ? { identity_at_collection: native.identity, collection: native.collection,
      coverage: native.coverage, events: native.events, selected_client_console_events: native.client_logs.filter(l =>
        l.client_session === options.boot_id || streams.client.events.some(e => e.native_log_sequence === l.native_sequence)) } : null,
    status: streams.client.unique_events && streams.association.matched_events ? 'associated_observations' : 'partial',
    root_cause: 'not_established', physical_validation: 'not_performed' };
  const file = await save(result, options.output_directory, 'correlation.json', signal);
  return { artifact: file, build: artifact, status: result.status, client_events: streams.client.unique_events,
    matched_events: streams.association.matched_events, missing_sequence_count: streams.client.missing_sequence_count,
    coverage: result.coverage, clocks: streams.clocks, root_cause: result.root_cause };
}
