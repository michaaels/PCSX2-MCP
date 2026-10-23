import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { IopBindings } from '../dist/iop-bindings.js';
import { parseIopModuleSnapshot } from '../dist/iop-modules.js';
import { workflowFixture } from './workflow-fixtures.mjs';
import { irxFixture, runtime, caps as oldCaps, hex } from './irx-fixtures.mjs';
const id = 'a'.repeat(32);
const source = { resolveIrx: async (file, sha, addresses) => ({ tool: null, locations: addresses.map(address =>
  ({ address, resolved: true, frames: [{ function: 'worker', file: 'fixture.c', line: 12 }] })) }) };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iop-binding-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const f = irxFixture(), r = runtime(f.bytes), irx = path.join(directory, 'fixture.irx'); await fs.writeFile(irx, f.bytes);
  r.module.record_address = hex(Number(r.module.text_address) - 48); r.module.module_id = 7;
  r.module.observed_generation = { scope: 'observed_loadcore_registration', namespace: '1:1:1', sequence: 41, registration_epoch: 12, module_id: 7 };
  r.image.image_record = r.image.head_address = r.table.head_address = r.module.record_address;
  r.image.iop_lifetime_epoch = r.table.iop_lifetime_epoch = 12;
  const caps = { ...oldCaps, iop_lifetime_epoch: 12, features: ['iop_module_image','iop_module_generations','iop_load_provenance','iop_lifetime'] };
  const sha = createHash('sha256').update(f.bytes).digest('hex'), x = r.irx;
  const receipt = { ok: true, watch_id: id, state: 'registered', active: false, session: caps.session,
    execution_epoch: caps.execution_epoch, iop_reset_epoch: caps.iop_reset_epoch, iop_lifetime_epoch: 12, elf: caps.elf, elf_crc: caps.elf_crc,
    path: irx, expected_sha256: sha, size: f.bytes.length, covered_bytes: f.bytes.length, read_count: 1, file_closed: true,
    binding_available: true, binding_reason: '', binding_revision: 9, buffer_address: '0x00100000', file_info_address: '0x001f0000',
    module_record: r.module.record_address, loader_sample_pc: '0x00015000', buffer_timestamp_ms: 1, registration_timestamp_ms: 2,
    file_info: [4,x.entry,x.gp,0x2000,x.textSize,x.dataSize,x.bssSize,x.memSize,x.modId].map(hex), source_bytes_base64: f.bytes.toString('base64') };
  const state = { paused: true };
  const { client, mock } = await workflowFixture(t, q => q.cmd === 'capabilities' ? caps : q.cmd === 'status' ?
    { ok: true, data: { alive: true, paused: state.paused, pc: '0x00100000', cycles: 1 } } : q.cmd === 'iop_load_status' ? receipt :
    q.cmd === 'iop_module_snapshot' ? r.table : q.cmd === 'iop_module_image' ? r.image : undefined);
  return { ...f, ...r, irx, sha, caps, receipt, state, client, mock, options: { irx, module_record: r.module.record_address, load_watch_id: id } };
}
test('binding creation requires capability, proven load and observed registration; copies summaries without leaking retained state', async t => {
  const f = await fixture(t), registry = new IopBindings(); f.caps.features = [];
  await assert.rejects(registry.create(f.client, f.options), /iop_module_generations/); f.caps.features = ['iop_module_image','iop_module_generations','iop_load_provenance'];
  f.module.observed_generation = null; await assert.rejects(registry.create(f.client, f.options), /observed registration/);
  f.module.observed_generation = { scope: 'observed_loadcore_registration', namespace: '1:1:1', sequence: 41, registration_epoch: 12, module_id: 7 };
  const b = await registry.create(f.client, f.options); assert.equal(b.origin.file_sha256, f.sha);
  b.artifact.sha256 = 'bad'; b.observed_generation.sequence = 0;
  assert.equal(registry.list().bindings[0].artifact.sha256, f.sha); assert.equal(registry.list().bindings[0].observed_generation.sequence, 41);
  assert.ok(!JSON.stringify(registry.list()).includes('source_bytes_base64'));
});
test('binding revalidation reads native images twice and resolves fresh sources, keeping origin hash historical', async t => {
  const f = await fixture(t), registry = new IopBindings(), b = await registry.create(f.client, f.options);
  f.receipt.binding_available = false; f.image.revision = f.table.revision = 11;
  const value = await registry.inspect(f.client, b.binding_id, undefined, undefined, source);
  assert.equal(value.locations[0].frames[0].function, 'worker'); assert.equal(value.evidence.original_loaded_file_sha256, null);
  assert.equal(value.binding.origin.file_sha256, f.sha);
  const images = f.mock.requests.filter(q => q.cmd === 'iop_module_image').slice(-2);
  assert.equal(images.length, 2); assert.ok(images.every(q => q.expected_registration_sequence === 41 && q.expected_revision === 11));
  assert.ok(f.mock.requests.every(q => ['capabilities','status','iop_load_status','iop_module_snapshot','iop_module_image'].includes(q.cmd)));
});
test('same-address/code re-registration invalidates the binding permanently even if old token is restored later', async t => {
  const f = await fixture(t), registry = new IopBindings(), b = await registry.create(f.client, f.options);
  f.module.observed_generation.sequence++;
  await assert.rejects(registry.inspect(f.client, b.binding_id, undefined, undefined, source), /registration generation/);
  f.module.observed_generation.sequence--;
  await assert.rejects(registry.inspect(f.client, b.binding_id), /invalidated/);
});

test('a recycled PID/session/sequence cannot reuse a binding from another native generation namespace', async t => {
  const f = await fixture(t), registry = new IopBindings(), b = await registry.create(f.client, f.options);
  f.module.observed_generation.namespace = '2:1:2';
  await assert.rejects(registry.inspect(f.client, b.binding_id, undefined, undefined, source), /namespace changed/);
});
test('artifact replacement and process change revoke retained identity before source work', async t => {
  const f = await fixture(t), registry = new IopBindings(), first = await registry.create(f.client, f.options);
  f.caps.process_id++;
  await assert.rejects(registry.inspect(f.client, first.binding_id), /identity changed/); f.caps.process_id--;
  const second = await registry.create(f.client, f.options);
  await fs.writeFile(f.irx, f.bytes); await fs.utimes(f.irx, new Date(), new Date(Date.now() + 20000));
  await assert.rejects(registry.inspect(f.client, second.binding_id), /artifact changed/);
});
test('capacity refuses without stealing IDs; wall expiry, selected drop and foreign drop preserve ownership', async t => {
  const f = await fixture(t); let now = 0; const registry = new IopBindings(() => now), bindings = [];
  for (let n = 0; n < 16; n++) bindings.push(await registry.create(f.client, { ...f.options, ttl_ms: 100 }));
  await assert.rejects(registry.create(f.client, f.options), /capacity/);
  assert.throws(() => registry.drop('f'.repeat(32)), /Unknown/); assert.equal(registry.list().bindings.length, 16);
  registry.drop(bindings[0].binding_id); assert.equal(registry.list().bindings.length, 15);
  now = 101; assert.ok(registry.list().bindings.every(b => b.status === 'expired'));
  await assert.rejects(registry.inspect(f.client, bindings[1].binding_id), /expired/);
  await registry.create(f.client, f.options); assert.equal(registry.list().bindings.length, 1);
});
test('running queries and aborted lookups preserve the retained ID, while release during worker cannot resurrect it', async t => {
  const f = await fixture(t), registry = new IopBindings(), b = await registry.create(f.client, f.options);
  f.state.paused = false; await assert.rejects(registry.inspect(f.client, b.binding_id), /Pause/); f.state.paused = true;
  const abort = new AbortController();
  await assert.rejects(registry.inspect(f.client, b.binding_id, undefined, abort.signal, { resolveIrx: async () => { abort.abort(); return { tool: null, locations: [] }; } }));
  assert.equal(registry.list().bindings[0].status, 'retained');
  await assert.rejects(registry.inspect(f.client, b.binding_id, undefined, undefined, { resolveIrx: async () => {
    registry.drop(b.binding_id); return { tool: null, locations: [] };
  } }), /released/); assert.equal(registry.list().bindings.length, 0);
});
test('post-worker generation changes discard a source result despite identical image bytes and pause revision', async t => {
  const f = await fixture(t), registry = new IopBindings(), b = await registry.create(f.client, f.options);
  await assert.rejects(registry.inspect(f.client, b.binding_id, undefined, undefined, { resolveIrx: async () => {
    f.module.observed_generation.sequence++; return { tool: null, locations: [] };
  } }), /identity/);
});
test('observed registration metadata validates module ID, sequence and epoch without upgrading legacy null identity', async t => {
  const f = await fixture(t); parseIopModuleSnapshot(f.table);
  for (const mutate of [s => s.modules[0].module_id++, s => s.modules[0].observed_generation.sequence = 0,
    s => s.modules[0].observed_generation.registration_epoch = 13]) {
    const copy = structuredClone(f.table); mutate(copy); assert.throws(() => parseIopModuleSnapshot(copy));
  }
  f.module.observed_generation = null; assert.equal(parseIopModuleSnapshot(f.table).modules[0].observed_generation, null);
});

test('IOP exception arming sends the lifetime guard and accepts explicit lifetime termination without fabricating a report', async t => {
  const f = await fixture(t);
  const state = { ok: true, watch_id: id, cpu: 'iop', iop_reset_epoch: f.caps.iop_reset_epoch, iop_reset_scope: 'cpu_reset_only',
    state: 'armed', active: true, session: f.caps.session, execution_epoch: f.caps.execution_epoch, elf: f.caps.elf, elf_crc: f.caps.elf_crc, report: null };
  const { client, mock } = await workflowFixture(t, () => state);
  await client.startExceptionWatch(id, f.caps, { cpu: 'iop' }); assert.equal(mock.requests[0].expected_iop_lifetime_epoch, 12);
  state.state = 'lifetime_changed'; state.active = false;
  const ended = await client.exceptionWatchStatus(id); assert.equal(ended.state, 'lifetime_changed'); assert.equal(ended.report, null);
});
