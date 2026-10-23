import test from 'node:test';
import assert from 'node:assert/strict';
import { lifetimeResponse, readIopLifetime } from '../dist/iop-lifetime.js';
import { decodeLoadReceipt, checkLoadAssociation } from '../dist/iop-load.js';
import { inspectRuntimeIrx } from '../dist/irx-tools.js';
import { workflowFixture } from './workflow-fixtures.mjs';
import { irxFixture, runtime, caps as oldCaps, hex } from './irx-fixtures.mjs';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const caps = { ...oldCaps, iop_lifetime_epoch: 12, features: [...oldCaps.features, 'iop_lifetime'] };
const report = () => ({ ok: true, session: caps.session, execution_epoch: caps.execution_epoch, iop_reset_epoch: caps.iop_reset_epoch,
  iop_lifetime_epoch: 12, scope: 'observed_boundaries_only', elf: caps.elf, elf_crc: caps.elf_crc, list_address: '0x00003000',
  history_truncated: false, events: [{ epoch: 11, timestamp_ms: 1, kind: 'load_object_call', address: '0x00100000' },
    { epoch: 12, timestamp_ms: 2, kind: 'register_module_call', address: '0x00001000' }] });

test('lifetime journal validates bounded contiguous epochs and distinguishes request observations from generations', () => {
  lifetimeResponse.parse(report());
  for (const mutate of [s => s.events[1].epoch = 10, s => s.iop_lifetime_epoch = 13, s => s.events = [],
    s => s.events[0].kind = 'software_reset_completed', s => s.scope = 'module_generations', s => s.history_truncated = true,
    s => s.events[0].timestamp_ms = -1, s => s.events = Array(65).fill(s.events[0])]) {
    const value = report(); mutate(value); assert.throws(() => lifetimeResponse.parse(value));
  }
});

test('lifetime tool checks capability without commands that mutate guest state and refuses changed sessions', async t => {
  let enabled = false, result = report();
  const { client, mock } = await workflowFixture(t, q => q.cmd === 'capabilities' ? enabled ? caps : oldCaps : result);
  await assert.rejects(readIopLifetime(client), /iop_lifetime/); assert.equal(mock.requests.length, 1); enabled = true;
  const accepted = await readIopLifetime(client); assert.equal(accepted.module_generation, null);
  assert.equal(accepted.scope, 'observed_boundaries_only');
  result = { ...report(), session: 2 }; await assert.rejects(readIopLifetime(client), /session changed/);
  result = report(); result.events = result.events.slice(0, 1); result.iop_lifetime_epoch = 11;
  await assert.rejects(readIopLifetime(client), /session changed/);
  assert.ok(mock.requests.every(q => ['capabilities', 'iop_lifetime'].includes(q.cmd)));
});

test('lifetime capability without its epoch fails closed before a guarded operation', async t => {
  const { client } = await workflowFixture(t, () => ({ ...caps, iop_lifetime_epoch: undefined }));
  await assert.rejects(client.getCapabilities(), /missing epoch/);
});

test('module and image requests send the lifetime guard and reject mismatched or omitted response epochs', async t => {
  const r = runtime(irxFixture().bytes); let epoch = 12;
  const { client, mock } = await workflowFixture(t, q => q.cmd === 'iop_module_snapshot' ? { ...r.table, iop_lifetime_epoch: epoch } :
    { ...r.image, iop_lifetime_epoch: epoch });
  await client.iopModuleSnapshot(caps); await client.iopModuleImage({ ...caps, revision: 9 }, r.module.record_address);
  assert.ok(mock.requests.every(q => q.expected_iop_lifetime_epoch === 12));
  for (epoch of [13, undefined]) {
    await assert.rejects(client.iopModuleSnapshot(caps), /identity/);
    await assert.rejects(client.iopModuleImage({ ...caps, revision: 9 }, r.module.record_address), /identity/);
  }
});

test('a full-file receipt cannot bind to identical code at a different observed lifetime epoch', () => {
  const bytes = irxFixture().bytes, r = runtime(bytes), x = r.irx, base = Number(r.module.text_address);
  const receipt = decodeLoadReceipt({ ok: true, watch_id: 'a'.repeat(32), state: 'registered', active: false,
    session: caps.session, execution_epoch: caps.execution_epoch, iop_reset_epoch: caps.iop_reset_epoch, iop_lifetime_epoch: 12,
    elf: caps.elf, elf_crc: caps.elf_crc, path: path.resolve('fixture.irx'), expected_sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length, covered_bytes: bytes.length, read_count: 1, file_closed: true, binding_available: true, binding_reason: '', binding_revision: 9,
    buffer_address: '0x00100000', file_info_address: '0x001f0000', module_record: hex(base - 48), loader_sample_pc: '0x00015000',
    buffer_timestamp_ms: 1, registration_timestamp_ms: 2, source_bytes_base64: bytes.toString('base64'),
    file_info: [4, x.entry, x.gp, base, x.textSize, x.dataSize, x.bssSize, x.memSize, x.modId].map(hex) });
  checkLoadAssociation(receipt, x, { ...r.image, iop_lifetime_epoch: 12 }, receipt.state.module_record);
  for (const epoch of [13, undefined])
    assert.throws(() => checkLoadAssociation(receipt, x, { ...r.image, iop_lifetime_epoch: epoch }, receipt.state.module_record), /guarded pause/);
});

test('IRX source lookup discards a result whose post-worker lifetime changed despite identical bytes, PC and revision', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lifetime-source-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const f = irxFixture(), r = runtime(f.bytes), irx = path.join(dir, 'fixture.irx'); await fs.writeFile(irx, f.bytes);
  let epoch = 12;
  const { client } = await workflowFixture(t, q => q.cmd === 'capabilities' ? caps : q.cmd === 'iop_module_snapshot' ?
    { ...r.table, iop_lifetime_epoch: 12 } : { ...r.image, iop_lifetime_epoch: epoch });
  await assert.rejects(inspectRuntimeIrx(client, { irx, module_record: r.module.record_address }, true, undefined,
    { resolveIrx: async () => { epoch++; return { tool: null, locations: [] }; } }), /identity/);
});
