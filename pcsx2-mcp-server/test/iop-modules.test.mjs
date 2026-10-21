import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIopModuleSnapshot, resolveIopModule } from '../dist/iop-modules.js';
import { readIopModules } from '../dist/iop-module-tools.js';
import { workflowFixture, capabilities } from './workflow-fixtures.mjs';
import { parseExceptionReport } from '../dist/exceptions.js';
import { contextResponse, history } from './fixtures.mjs';

const caps = { ...capabilities, execution_epoch: 7, iop_reset_epoch: 3, iop_reset_scope: 'cpu_reset_only', features: ['iop_module_snapshot'] };
function snapshot() {
  return { ok: true, cpu: 'iop', snapshot_id: 1, timestamp_ms: 100, session: 1, execution_epoch: 7, iop_reset_epoch: 3,
    iop_reset_scope: 'cpu_reset_only', revision: 12, elf: caps.elf, elf_crc: caps.elf_crc, elf_role: 'ee_boot_affinity_only',
    scope: 'paused_runtime_observation_only', source: 'pcsx2_detected_loadcore_list', root_discovery_sequence: 2,
    list_address: '0x00000800', head_address: '0x00001000', status: 'observed', reason: null,
    modules: [{ record_address: '0x00001000', next_address: '0x00000000', name_address: '0x00001100', name: 'fixture', version: 0x101,
      entry: '0x00020000', gp: '0x00028000', text_address: '0x00020000', text_size: 0x100, data_size: 0x20, bss_size: 0x10 }] };
}
test('runtime association uses half-open text/data/BSS ranges, preserving unknown artifact/source identity', () => {
  const s = parseIopModuleSnapshot(snapshot());
  for (const [pc, segment, offset] of [['0x00020000', 'text', '0x00000000'], ['0x000200ff', 'text', '0x000000ff'],
    ['0x00020100', 'data', '0x00000000'], ['0x00020120', 'bss', '0x00000000']]) {
    const r = resolveIopModule(s, pc); assert.equal(r.status, 'matched_runtime_range'); assert.equal(r.segment, segment);
    assert.equal(r.segment_offset, offset); assert.equal(r.artifact_identity, null); assert.equal(r.source_mapping, null);
  }
  for (const pc of ['0x0001ffff', '0x00020130']) assert.equal(resolveIopModule(s, pc).status, 'unmapped');
  for (const pc of ['0x80020000', '0x1fc00000', '0x00200000']) assert.equal(resolveIopModule(s, pc).status, 'excluded_address');
});
test('duplicate names are not identity; overlapping ranges stay ambiguous and excluded/overflowed ranges never wrap', () => {
  const s = snapshot(); s.modules[0].next_address = '0x00001200';
  s.modules.push({ ...s.modules[0], record_address: '0x00001200', next_address: '0x00000000' });
  const r = resolveIopModule(parseIopModuleSnapshot(s), '0x00020004'); assert.equal(r.status, 'ambiguous'); assert.equal(r.candidates.length, 2);
  s.modules[1].text_address = '0xfffffff0'; s.modules[1].text_size = 0xffffffff;
  assert.equal(resolveIopModule(parseIopModuleSnapshot(s), '0x00020004').status, 'matched_runtime_range');
  s.modules[0].text_size = 0; s.modules[0].data_size = 0; s.modules[0].bss_size = 0;
  assert.equal(resolveIopModule(parseIopModuleSnapshot(s), '0x00020004').status, 'unmapped');
});
test('invalid record/name chains, unsafe pointers and incomplete snapshots never produce identities', () => {
  for (const mutate of [s => s.modules[0].next_address = s.modules[0].record_address, s => s.head_address = '0x00001100',
    s => s.list_address = '0x1f801000', s => s.modules[0].record_address = '0x001ffff0', s => s.modules[0].name = 'a\n',
    s => s.modules[0].name = 'x'.repeat(128), s => s.modules[0].name_address = '0x1f801000',
    s => s.modules[0].name = null, s => { s.modules[0].record_address = '0x00000000'; s.head_address = '0x00000000'; },
    s => s.modules[0].version = 65536, s => s.reason = 'incomplete', s => s.root_discovery_sequence = 0]) {
    const s = snapshot(); mutate(s); assert.throws(() => parseIopModuleSnapshot(s));
  }
  const unavailable = snapshot(); unavailable.status = 'unavailable'; unavailable.reason = 'module_list_cycle'; unavailable.modules = [];
  assert.equal(resolveIopModule(parseIopModuleSnapshot(unavailable), '0x00020000').status, 'unavailable');
  unavailable.modules = snapshot().modules; assert.throws(() => parseIopModuleSnapshot(unavailable));
  const romName = snapshot(); romName.modules[0].name_address = '0xbfc00000'; assert.ok(parseIopModuleSnapshot(romName));
});
test('module request guards VM/reset identity and never pauses, resumes or writes; old backends refuse before request', async t => {
  let value = snapshot(), supported = true;
  const { client, mock } = await workflowFixture(t, r => r.cmd === 'capabilities' ? (supported ? caps : capabilities) : r.cmd === 'iop_module_snapshot' ? value : undefined);
  assert.equal((await readIopModules(client, '0x00020000')).association.status, 'matched_runtime_range');
  const sent = mock.requests.find(r => r.cmd === 'iop_module_snapshot');
  assert.equal(sent.expected_iop_reset_epoch, 3); assert.equal(sent.expected_execution_epoch, 7);
  for (const mutate of [s => s.iop_reset_epoch++, s => s.session++, s => s.execution_epoch++, s => s.elf = 'wrong.elf']) {
    value = snapshot(); mutate(value); await assert.rejects(readIopModules(client), /identity mismatch/);
  }
  assert.ok(mock.requests.every(r => ['capabilities', 'iop_module_snapshot'].includes(r.cmd)));
  supported = false; const before = mock.requests.length; await assert.rejects(readIopModules(client), /iop_module_snapshot/);
  assert.equal(mock.requests.length, before + 1);
});
test('IOP exception attaches frozen runtime association, not EE or local IRX source identity', () => {
  const s = snapshot(), context = contextResponse(); context.cpu = 'iop'; context.elf = caps.elf;
  const cp0 = Array(32).fill('0x00000000'); cp0[13] = '0x00000024'; cp0[14] = '0x00020000'; cp0[12] = '0x00400404';
  const r = { watch_id: 'a'.repeat(32), cpu: 'iop', timestamp_ms: 1, session: 1, execution_epoch: 7, iop_reset_epoch: 3,
    iop_reset_scope: 'cpu_reset_only', elf: caps.elf, elf_crc: caps.elf_crc, elf_role: 'ee_boot_affinity_only', module_identity: null,
    context_matches_stop: true, screenshot_requested: false, module_observation: s,
    core: { exception_pc: '0x00020000', post_exception_pc: '0x00100000', raw_code: '0x00000024', exception_code: 9,
      requested_branch_delay: false, previous_exl: null, previous_status: '0x00400401', hi: '0x00000000', lo: '0x00000000',
      cause: cp0[13], epc: cp0[14], bad_vaddr: cp0[8], status: cp0[12], bad_vaddr_relevant: false,
      instruction: { source: 'iop_recompiler_break', pc: '0x00020004', opcode: '0x0000000d', branch_delay: true, opcode_matches_memory: true },
      gpr: Array(32).fill('0'.repeat(32)), cp0 }, memory: {}, events: history('events'), context };
  const parsed = parseExceptionReport(r);
  assert.equal(parsed.module_evidence.status, 'matched_runtime_range'); assert.equal(parsed.module_evidence.address, '0x00020004');
  assert.equal(parsed.module_evidence.address_basis, 'verified_jit_instruction'); assert.equal(parsed.module_identity, null);
  assert.ok(parsed.partial_reasons.includes('iop_module_identity_unavailable'));
  r.core.instruction.opcode_matches_memory = false;
  assert.equal(parseExceptionReport(r).module_evidence.address_basis, 'raw_exception_entry');
  for (const mutate of [s => s.module_observation.iop_reset_epoch++, s => s.module_observation.elf = 'wrong.elf',
    s => s.module_observation.session++, s => s.context_matches_stop = false]) {
    const bad = structuredClone(r); mutate(bad); assert.throws(() => parseExceptionReport(bad));
  }
});
