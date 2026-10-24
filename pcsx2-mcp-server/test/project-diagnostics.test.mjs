import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { collectProjectDiagnostics, correlateProjectDiagnostics, correlateStreams, parseClientConsole } from '../dist/project-diagnostics.js';
import { inspectSourceElf } from '../dist/source-debug.js';
import { debugServer } from './fixtures.mjs';

const buildId = '0123456789abcdef', bootId = 'a'.repeat(16), nextBoot = 'b'.repeat(16), secret = 'DO_NOT_COPY_password_token_https://private/secret';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const diagnostic = (sequence = 0, overrides = {}) => ({ buildId, bootId, sequence, event: sequence ? 'network_ready' : 'boot',
  level: 'INFO', uptimeMs: sequence * 100, dropped: 0, sessionId: bootId, deviceId: 'test-device',
  receivedAt: new Date(1700000000000 + sequence * 100).toISOString(), ...overrides });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcsx2-project-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const elf = path.join(directory, 'test.elf'), bytes = Buffer.alloc(84);
  bytes.set([127, 69, 76, 70, 1, 1, 1]); bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(8, 18); bytes.writeUInt32LE(1, 20);
  bytes.writeUInt32LE(52, 28); bytes.writeUInt16LE(52, 40); bytes.writeUInt16LE(32, 42); bytes.writeUInt16LE(1, 44);
  bytes.writeUInt32LE(1, 52); bytes.writeUInt32LE(84, 68); bytes.writeUInt32LE(84, 72); bytes.writeUInt32LE(5, 76);
  await fs.writeFile(elf, bytes); const identity = await inspectSourceElf(elf);
  const manifest = path.join(directory, 'manifest.json'), bridge = path.join(directory, 'ps2.jsonl');
  const manifestData = { format_version: 1, build_id: buildId, elf_sha256: identity.sha256, pcsx2_crc: identity.elf_crc,
    private_extra_field: secret };
  await fs.writeFile(manifest, JSON.stringify(manifestData)); await fs.writeFile(bridge, JSON.stringify(diagnostic()) + '\n');
  const caps = { ok: true, protocol_version: 2, process_id: 42, session: 2, execution_epoch: 7,
    elf: `host:${elf}`, elf_crc: identity.elf_crc, features: ['events', 'console_logs'] };
  const options = { manifest_path: manifest, elf_path: elf, output_directory: directory };
  return { directory, elf, manifest, manifestData, bridge, caps, options };
}
async function native(t, f, transform = value => value) {
  const mock = await debugServer(t, request => {
    if (request.cmd === 'capabilities') return transform({ ...f.caps }, request);
    const isLog = request.cmd === 'read_logs';
    const entries = isLog ? [
      { sequence: 1, timestamp_ms: 2000, source: 'console', level: 3,
        message: `JFCLIENT event=boot level=INFO sequence=0 session=${bootId}\n`, truncated: false },
      { sequence: 2, timestamp_ms: 2001, source: 'console', level: 3, message: secret, truncated: false },
      { sequence: 3, timestamp_ms: 2002, source: 'console', level: 3,
        message: `JFCLIENT event=network_ready level=INFO sequence=1 session=${bootId}`, truncated: true },
    ] : [{ sequence: 1, timestamp_ms: 1999, type: 'paused', cpu: 'ee', pc: '0x00100000', detail: secret }];
    const selected = entries.filter(entry => entry.sequence > request.after);
    return transform({ ok: true, session: 2, oldest_sequence: 1, dropped: false,
      next_cursor: selected.at(-1)?.sequence ?? request.after, [isLog ? 'logs' : 'events']: selected }, request);
  });
  const client = new DebugServerClient('127.0.0.1', mock.port); await client.connect(); t.after(() => client.disconnect());
  return { client, requests: mock.requests };
}

test('SMS console parsing accepts only complete allowlisted fields and never free text or truncated input', () => {
  const text = `JFCLIENT event=boot level=INFO sequence=0 session=${bootId}`;
  assert.equal(parseClientConsole(text, false).client_session, bootId);
  for (const message of [secret, text + ' ' + secret, 'prefix ' + text, text.replace('boot ', 'unknown_event '),
    text.replace('sequence=0', 'sequence=4294967296'), text.replace(bootId, 'not-a-session')])
    assert.equal(parseClientConsole(message, false), null);
  assert.equal(parseClientConsole(text, true), null);
});

test('read-only capture binds manifest/ELF/native identity and saves sanitized fields without raw paths or credentials', async t => {
  const f = await fixture(t), mock = await native(t, f);
  const result = await collectProjectDiagnostics(mock.client, f.options);
  const bytes = await fs.readFile(result.artifact.path), text = bytes.toString();
  assert.equal(digest(bytes), result.artifact.sha256); assert.equal(text.includes(secret), false);
  assert.equal(text.includes(f.directory.replaceAll('\\', '\\\\')), false);
  assert.equal(result.client_log_entries, 1); assert.equal(result.coverage.discarded_console_messages, 2);
  assert.equal(result.coverage.truncated_console_messages, 1); assert.deepEqual(result.observed_boot_ids, [bootId]);
  assert.equal(result.guest_state_changed_by_tool, false);
  assert.ok(mock.requests.every(request => ['capabilities', 'read_events', 'read_logs'].includes(request.cmd)));
});

test('capture rejects changed native identity, a foreign loaded path and manifest mismatch before saving', async t => {
  const f = await fixture(t); let count = 0;
  const mock = await native(t, f, (value, request) => request.cmd === 'capabilities' && ++count > 1 ? { ...value, execution_epoch: 8 } : value);
  await assert.rejects(collectProjectDiagnostics(mock.client, f.options), /identity changed/);
  const foreign = await native(t, f, (value, request) => request.cmd === 'capabilities' ? { ...value, elf_crc: '0x00000000' } : value);
  await assert.rejects(collectProjectDiagnostics(foreign.client, f.options), /differs/);
  await fs.writeFile(f.manifest, JSON.stringify({ ...f.manifestData, elf_sha256: '0'.repeat(64) }));
  await assert.rejects(collectProjectDiagnostics(foreign.client, f.options), /mismatch/);
  assert.equal((await fs.readdir(f.directory)).some(name => name.startsWith('ps2-diagnostics-')), false);
});

test('history page ceilings and dropped records stay explicit; malformed cursors/session are rejected', async t => {
  const f = await fixture(t);
  const mock = await native(t, f, (value, request) => request.cmd === 'read_logs' ? { ...value, dropped: true,
    logs: Array.from({ length: 200 }, (_, i) => ({ sequence: i + 1, timestamp_ms: i, source: 'console', level: 3, message: 'ignored', truncated: false })), next_cursor: 200 } : value);
  const result = await collectProjectDiagnostics(mock.client, { ...f.options, pages: 1 });
  assert.equal(result.coverage.logs_dropped, true); assert.equal(result.coverage.logs_page_limit, true);
  for (const change of [{ session: 3 }, { next_cursor: 99 }]) {
    const bad = await native(t, f, (value, request) => request.cmd === 'read_logs' ? { ...value, ...change } : value);
    await assert.rejects(collectProjectDiagnostics(bad.client, f.options), /session|cursor/);
  }
});

test('offline association joins exact reported fields only and retains separate uncalibrated clock domains', async t => {
  const f = await fixture(t), mock = await native(t, f), saved = await collectProjectDiagnostics(mock.client, f.options);
  const result = await correlateProjectDiagnostics({ ...f.options, capture_path: saved.artifact.path, capture_sha256: saved.artifact.sha256, bridge_log_path: f.bridge, boot_id: bootId });
  const bytes = await fs.readFile(result.artifact.path), report = JSON.parse(bytes);
  assert.equal(result.status, 'associated_observations'); assert.equal(result.matched_events, 1);
  assert.equal(report.association.authenticated, false); assert.equal(report.client.events[0].native_log_sequence, 1);
  assert.equal(report.clocks.uncertainty, 'unbounded'); assert.equal(report.clocks.transport_latency_ms, null);
  assert.equal(report.clocks.merged_timeline, 'not_constructed'); assert.equal(report.root_cause, 'not_established');
  assert.equal(bytes.includes(Buffer.from(secret)), false); assert.equal(bytes.includes(Buffer.from('test-device')), false);
});

test('missing capture, absent boot and an empty Bridge file produce explicit partial evidence', async t => {
  const f = await fixture(t);
  const input = { ...f.options, bridge_log_path: f.bridge, boot_id: bootId };
  const noNative = await correlateProjectDiagnostics(input); assert.equal(noNative.status, 'partial'); assert.equal(noNative.matched_events, 0);
  await fs.writeFile(f.bridge, '');
  const empty = await correlateProjectDiagnostics(input); assert.equal(empty.client_events, 0); assert.equal(empty.status, 'partial');
});

test('conflicting sequences and devices never merge; identical duplicate receipts do not create extra client events', () => {
  const build = { build_id: buildId };
  assert.throws(() => correlateStreams(null, [diagnostic(), diagnostic(0, { event: 'client_error' })], build, bootId), /Conflicting/);
  assert.throws(() => correlateStreams(null, [diagnostic(), diagnostic(1, { deviceId: 'other-device' })], build, bootId), /Multiple devices/);
  const duplicate = correlateStreams(null, [diagnostic(), diagnostic(0, { receivedAt: new Date(1700000000001).toISOString() })], build, bootId);
  assert.equal(duplicate.client.unique_events, 1); assert.equal(duplicate.client.events[0].duplicate_receipts, 1);
  const scoped = correlateStreams(null, [diagnostic(), diagnostic(1, { deviceId: 'other-device' })], build, bootId, digest('test-device'));
  assert.equal(scoped.client.unique_events, 1);
});

test('a missing/duplicate boot anchor and events after another boot cannot establish association', () => {
  const build = { build_id: buildId }, boot = { native_sequence: 1, native_timestamp_ms: 99, event: 'boot', level: 'INFO', client_sequence: 0, client_session: bootId };
  const event = { ...boot, native_sequence: 3, event: 'network_ready', client_sequence: 1 };
  for (const logs of [[event], [boot, { ...boot, native_sequence: 2 }], [boot, { ...boot, native_sequence: 2, client_session: nextBoot }, event]]) {
    const result = correlateStreams({ client_logs: logs }, [diagnostic(1)], build, bootId);
    assert.equal(result.association.matched_events, 0);
  }
  const ambiguous = correlateStreams({ client_logs: [boot, event, { ...event, native_sequence: 4 }] }, [diagnostic(1)], build, bootId);
  assert.equal(ambiguous.client.events[0].association, 'ambiguous_console_matches');
});

test('sequence gaps and uptime regressions/wraps preserve unknown deltas rather than fabricated measurements', () => {
  const result = correlateStreams(null, [diagnostic(1, { uptimeMs: 1000 }), diagnostic(4, { uptimeMs: 1, dropped: 2 })], { build_id: buildId }, bootId);
  assert.equal(result.client.missing_sequence_count, 3); assert.equal(result.client.uptime_regressions_or_wraps, 1);
  assert.equal(result.client.events[1].since_previous_client_event_ms, null);
});

test('bad JSONL, extra secret fields, oversized lines and foreign imported builds fail without echoing source contents', async t => {
  const f = await fixture(t), mock = await native(t, f), saved = await collectProjectDiagnostics(mock.client, f.options);
  const input = { ...f.options, bridge_log_path: f.bridge, boot_id: bootId, capture_path: saved.artifact.path, capture_sha256: saved.artifact.sha256 };
  for (const text of [secret, JSON.stringify({ ...diagnostic(), password: secret }), 'a'.repeat(2049)]) {
    await fs.writeFile(f.bridge, text);
    await assert.rejects(correlateProjectDiagnostics(input), error => !error.message.includes(secret));
  }
  await fs.writeFile(f.bridge, JSON.stringify(diagnostic()));
  await assert.rejects(correlateProjectDiagnostics({ ...input, capture_sha256: undefined }), /together/);
  await assert.rejects(correlateProjectDiagnostics({ ...input, capture_sha256: '0'.repeat(64) }), /SHA256 differs/);
  const capture = JSON.parse(await fs.readFile(saved.artifact.path)); capture.build.build_id = nextBoot;
  const changed = JSON.stringify(capture); await fs.writeFile(saved.artifact.path, changed);
  await assert.rejects(correlateProjectDiagnostics({ ...input, capture_sha256: digest(changed) }), /different.*build/);
});

test('cancellation never sends a pause, resume, mutation or native cleanup command', async t => {
  const f = await fixture(t), mock = await native(t, f); const controller = new AbortController(); controller.abort();
  await assert.rejects(collectProjectDiagnostics(mock.client, f.options, controller.signal), /abort/i);
  assert.equal(mock.requests.length, 0);
});
