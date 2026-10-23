import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { loadState, decodeLoadReceipt, checkLoadAssociation } from '../dist/iop-load.js';
import { startIopLoadWatch, readIopLoadReport } from '../dist/iop-load-tools.js';
import { inspectRuntimeIrx } from '../dist/irx-tools.js';
import { parseIrx, verifyIrxImage } from '../dist/irx.js';
import { workflowFixture } from './workflow-fixtures.mjs';
import { irxFixture, runtime, caps as oldCaps, hex } from './irx-fixtures.mjs';

const caps = { ...oldCaps, features: [...oldCaps.features, 'iop_load_provenance'] };
const sha = b => createHash('sha256').update(b).digest('hex');
const id = 'a'.repeat(32);
function receipt(bytes = irxFixture().bytes) {
  const x = parseIrx(bytes), base = 0x2000;
  return { ok: true, watch_id: id, state: 'registered', active: false, session: caps.session,
    execution_epoch: caps.execution_epoch, iop_reset_epoch: caps.iop_reset_epoch, elf: caps.elf, elf_crc: caps.elf_crc,
    path: path.resolve('fixture.irx'), expected_sha256: sha(bytes), size: bytes.length, covered_bytes: bytes.length,
    read_count: 1, file_closed: true, binding_available: true, binding_reason: '', binding_revision: 9,
    buffer_address: '0x00100000', file_info_address: '0x001f0000', module_record: hex(base - 48), loader_sample_pc: '0x00015000',
    buffer_timestamp_ms: 1, registration_timestamp_ms: 2,
    file_info: [4, x.entry, x.gp, base, x.textSize, x.dataSize, x.bssSize, x.memSize, x.modId].map(hex),
    source_bytes_base64: bytes.toString('base64') };
}
const pending = s => ({ ...s, state: 'armed', active: true, covered_bytes: 0, read_count: 0, file_closed: false,
  binding_available: false, binding_revision: 0, source_bytes_base64: null });
async function local(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iop-load-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const f = irxFixture(), irx = path.join(dir, 'fixture.irx'); await fs.writeFile(irx, f.bytes);
  const r = runtime(f.bytes); r.module.record_address = hex(Number(r.module.text_address) - 48);
  r.image.image_record = r.image.head_address = r.table.head_address = r.module.record_address;
  return { ...f, ...r, irx };
}

test('load receipt requires complete closed-descriptor coverage, canonical full bytes, SHA and matching FileInfo', () => {
  const r = receipt(), decoded = decodeLoadReceipt(r);
  assert.equal(decoded.summary.file_sha256, sha(irxFixture().bytes)); assert.equal(decoded.summary.source_bytes_base64, undefined);
  for (const mutate of [s => s.covered_bytes--, s => s.file_closed = false, s => s.read_count = 0,
    s => s.active = true, s => s.source_bytes_base64 = 'eA==', s => s.expected_sha256 = '0'.repeat(64),
    s => s.file_info[4] = '0x00000004', s => s.file_info[8] = '0x00000000',
    s => s.module_record = '0x00001000', s => s.buffer_address = '0x00200000', s => s.file_info_address = '0x80100000']) {
    const value = structuredClone(r); mutate(value); assert.throws(() => decodeLoadReceipt(value));
  }
  assert.throws(() => decodeLoadReceipt(pending(r)), /not registered/);
  assert.throws(() => loadState.parse({ ...pending(r), source_bytes_base64: r.source_bytes_base64 }));
});

test('full-load association compares writable initializers and relocation plan, independently of read-only code proof', () => {
  const f = irxFixture(), observed = decodeLoadReceipt(receipt(f.bytes)), r = runtime(f.bytes);
  checkLoadAssociation(observed, r.irx, r.image, observed.state.module_record);
  const initializer = Buffer.from(f.bytes); initializer[f.load + 159] ^= 1;
  verifyIrxImage(parseIrx(initializer), r.module, r.actual);
  assert.throws(() => checkLoadAssociation(observed, parseIrx(initializer), r.image, observed.state.module_record), /complete captured/);
  const relocation = Buffer.from(f.bytes); relocation.writeUInt32LE(1, f.load + 160 + 4);
  assert.throws(() => checkLoadAssociation(observed, parseIrx(relocation), r.image, observed.state.module_record), /relocation plan/);
  const metadata = Buffer.from(f.bytes); metadata.writeUInt32LE(140, 116);
  assert.throws(() => checkLoadAssociation(observed, parseIrx(metadata), r.image, observed.state.module_record), /complete captured/);
  // A companion may differ in nonloaded DWARF bytes without changing the original file identity.
  const companion = Buffer.from(f.bytes); companion[companion.readUInt32LE(f.headers['.debug_line'] + 16)] ^= 1;
  assert.notEqual(sha(companion), observed.summary.file_sha256);
  checkLoadAssociation(observed, parseIrx(companion), r.image, observed.state.module_record);
});

test('historical full-file receipt never substitutes for current pause, VM, IOP or module identity', () => {
  const s = receipt(), decoded = decodeLoadReceipt(s), r = runtime(irxFixture().bytes);
  for (const key of ['session', 'execution_epoch', 'iop_reset_epoch', 'revision'])
    assert.throws(() => checkLoadAssociation(decoded, r.irx, { ...r.image, [key]: r.image[key] + 1 }, s.module_record), /guarded pause/);
  for (const change of [{ elf: 'other.elf' }, { elf_crc: '0x87654321' }])
    assert.throws(() => checkLoadAssociation(decoded, r.irx, { ...r.image, ...change }, s.module_record));
  const expired = decodeLoadReceipt({ ...s, binding_available: false, binding_reason: 'pause_scope_ended' });
  assert.equal(expired.summary.file_sha256, decoded.summary.file_sha256);
  assert.throws(() => checkLoadAssociation(expired, r.irx, r.image, s.module_record));
});

test('watch arming checks capabilities and artifact before starting, without guest execution commands', async t => {
  const f = await local(t); let enabled = false;
  const { client, mock } = await workflowFixture(t, q => {
    if (q.cmd === 'capabilities') return enabled ? caps : oldCaps;
    if (q.cmd === 'iop_load_start') return { ...pending(receipt(f.bytes)), watch_id: q.watch_id, path: q.path };
  });
  await assert.rejects(startIopLoadWatch(client, { irx: f.irx }), /iop_load_provenance/); enabled = true;
  await assert.rejects(startIopLoadWatch(client, { irx: f.irx, expected_sha256: '0'.repeat(64) }), /SHA256/);
  assert.ok(!mock.requests.some(q => q.cmd === 'iop_load_start'));
  assert.equal((await startIopLoadWatch(client, { irx: f.irx })).resumes_vm, false);
  const q = mock.requests.at(-1); assert.equal(q.expected_process_id, caps.process_id); assert.equal(q.expected_iop_reset_epoch, caps.iop_reset_epoch);
  assert.equal(q.prefix, f.bytes.subarray(0, 64).toString('hex')); assert.equal(q.size, f.bytes.length);
  assert.ok(mock.requests.every(q => ['capabilities', 'iop_load_start'].includes(q.cmd)));
});

test('explicit competing-start rejection leaves the foreign watch untouched', async t => {
  const f = await local(t);
  const { client, mock } = await workflowFixture(t, q => q.cmd === 'capabilities' ? caps : { ok: false, error: 'already active' });
  await assert.rejects(startIopLoadWatch(client, { irx: f.irx }), /already active/);
  assert.ok(!mock.requests.some(q => q.cmd === 'iop_load_cancel'));
});

test('uncertain start and post-arm file replacement cancel only the attempted watch ID', async t => {
  const f = await local(t); let replace = false;
  const { client, mock } = await workflowFixture(t, async q => {
    if (q.cmd === 'capabilities') return caps;
    if (q.cmd === 'iop_load_start') {
      const state = { ...pending(receipt(f.bytes)), watch_id: q.watch_id, path: q.path };
      if (!replace) return { ...state, watch_id: 'b'.repeat(32) };
      await fs.appendFile(f.irx, Buffer.from([0])); return state;
    }
    if (q.cmd === 'iop_load_cancel') return { ...pending(receipt(f.bytes)), watch_id: q.watch_id, state: 'cancelled', active: false };
  });
  await assert.rejects(startIopLoadWatch(client, { irx: f.irx }), /identity/); replace = true;
  await assert.rejects(startIopLoadWatch(client, { irx: f.irx }), /changed during arming/);
  const starts = mock.requests.filter(q => q.cmd === 'iop_load_start'), cancels = mock.requests.filter(q => q.cmd === 'iop_load_cancel');
  assert.deepEqual(cancels.map(q => q.watch_id), starts.map(q => q.watch_id));
});

test('report timeout and abort retain ownership; registered reports omit raw file bytes and reject corrupt hashes', async t => {
  let state = pending(receipt());
  const { client, mock } = await workflowFixture(t, () => state);
  assert.equal((await readIopLoadReport(client, id, 10)).timed_out, true);
  const abort = new AbortController(); abort.abort(); await assert.rejects(readIopLoadReport(client, id, 100, abort.signal));
  assert.ok(mock.requests.every(q => q.cmd === 'iop_load_status'));
  state = receipt(); const report = await readIopLoadReport(client, id); assert.equal(report.source_bytes_base64, undefined); assert.equal(report.timed_out, false);
  state.expected_sha256 = 'f'.repeat(64); await assert.rejects(readIopLoadReport(client, id), /SHA256/);
});

test('source lookup rechecks observed full-file receipt after the worker and refuses old capability before snapshots', async t => {
  const f = await local(t); let supported = false, statuses = 0, lost = false;
  const { client, mock } = await workflowFixture(t, q => {
    if (q.cmd === 'capabilities') return supported ? caps : oldCaps;
    if (q.cmd === 'iop_module_snapshot') return f.table;
    if (q.cmd === 'iop_module_image') return f.image;
    if (q.cmd === 'iop_load_status') { statuses++; return { ...receipt(f.bytes), binding_available: !lost }; }
  });
  const options = { irx: f.irx, module_record: f.module.record_address, load_watch_id: id };
  await assert.rejects(inspectRuntimeIrx(client, options), /iop_load_provenance/); assert.equal(mock.requests.length, 1); supported = true;
  const ok = await inspectRuntimeIrx(client, options, true, undefined, { resolveIrx: async () => ({ tool: null, locations: [] }) });
  assert.equal(ok.evidence.original_loaded_file_sha256, sha(f.bytes)); assert.equal(statuses, 2);
  await assert.rejects(inspectRuntimeIrx(client, options, true, undefined, { resolveIrx: async () => { lost = true; return { tool: null, locations: [] }; } }), /guarded pause/);
});
