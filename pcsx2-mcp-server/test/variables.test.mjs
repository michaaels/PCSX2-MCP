import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { VariableReader, VariableUnavailable, variableMetadata, variableOptions } from '../dist/variables.js';
import { SourceVariables } from '../dist/source-variables.js';
import { inspectSourceElf } from '../dist/source-debug.js';
import { workflowFixture, capabilities } from './workflow-fixtures.mjs';

const hex = value => '0x' + BigInt(value).toString(16).padStart(32, '0');
const expression = (...ops) => ({ status: 'expression', ops: ops.map(([op, ...args]) => ({ op, args: args.map(String) })) });
function metadata() {
  return variableMetadata.parse({ format_version: 1, sha256: 'a'.repeat(64), pc: '0x00100000', dwarf_version: 2, function: 'test', id: '1',
    ranges: [[0x100000, 0x100100]], source_line: 4, location_guard: 'compiler_reported', has_prologue_marker: false,
    frame_base: expression(['DW_OP_reg29']), cfa: { status: 'register_offset', register: 29, offset: '16' }, scopes: [], inline_scopes: [],
    variables: [{ id: '2', name: 'argument', scope: '1', kind: 'argument', type: '10', location: expression(['DW_OP_reg4']) }],
    types: { '10': { name: 'int', kind: 'base', size: 4, encoding: 5 }, '11': { name: 'uint64', kind: 'base', size: 8, encoding: 7 },
      '12': { name: '<anonymous>', kind: 'array', size: null, target: '10', count: 3 },
      '13': { name: 'Pair', kind: 'struct', size: 16, members: [{ name: 'number', type: '10', offset: 0 }, { name: 'array', type: '12', offset: 4 }] },
      '14': { name: '<anonymous>', kind: 'pointer', size: 4, target: '13' },
      '15': { name: 'float', kind: 'base', size: 4, encoding: 4 } } });
}
function reader(meta = metadata(), settings = {}, memory = Buffer.alloc(256)) {
  const gpr = Array.from({ length: 32 }, () => hex(0)); gpr[4] = hex(23); gpr[29] = hex(0x1000);
  const calls = [];
  const value = new VariableReader(meta, gpr, async (address, length) => {
    calls.push({ address, length }); const offset = Number(address) - 0x1000;
    if (offset < 0 || offset + length > memory.length) throw new VariableUnavailable('invalid_memory');
    return memory.subarray(offset, offset + length).toString('hex');
  }, variableOptions.parse(settings));
  return { value, gpr, memory, calls, meta };
}

test('DWARF locations use GPR values, frame bases, CFA and exact 64-bit constants without Number rounding', async () => {
  const f = reader(); f.memory.writeUInt32LE(0x1010, 0);
  const reg = await f.value.expression(expression(['DW_OP_reg4']));
  assert.equal((await f.value.render('argument', '10', reg)).value, '23');
  assert.equal((await f.value.expression(expression(['DW_OP_fbreg', -4]))).value, 0xffcn);
  assert.equal((await f.value.expression(expression(['DW_OP_call_frame_cfa'], ['DW_OP_plus_uconst', 8]))).value, 0x1018n);
  assert.equal((await f.value.expression(expression(['DW_OP_breg29', 0], ['DW_OP_deref']))).value, 0x1010n);
  const literal = await f.value.expression(expression(['DW_OP_const8u', '18364758544493064720'], ['DW_OP_stack_value']));
  assert.equal((await f.value.render('wide', '11', literal)).value, '18364758544493064720');
  await assert.rejects(f.value.expression(expression(['DW_OP_piece', 4])), /unsupported_expression/);
  await assert.rejects(f.value.expression(expression(['DW_OP_reg32'])), /unsupported_register/);
  await assert.rejects(f.value.expression({ status: 'not_live_at_pc' }), /not_live/);
});

test('scalar and nested aggregate decoding preserves signs, float values and member/array offsets', async () => {
  const f = reader(metadata(), { max_depth: 4 });
  f.memory.writeInt32LE(-7, 0); [3, 5, 8].forEach((n, i) => f.memory.writeInt32LE(n, 4 + i * 4));
  f.memory.writeFloatLE(1.25, 32);
  const pair = await f.value.render('pair', '13', { kind: 'address', value: 0x1000n });
  assert.equal(pair.status, 'available'); assert.equal(pair.children[0].value, '-7');
  assert.deepEqual(pair.children[1].children.map(item => item.value), ['3', '5', '8']);
  assert.equal((await f.value.render('float', '15', { kind: 'address', value: 0x1020n })).value, '1.25');
  const pointer = await f.value.render('pointer', '14', { kind: 'value', value: 0x1000n });
  assert.equal(pointer.children, undefined); assert.equal(pointer.type, 'Pair*');
});

test('pointer, depth, child, node and byte budgets report partial/unavailable values without fabricated zeros', async () => {
  const f = reader(metadata(), { follow_pointers: true, max_depth: 4, max_children: 1, max_bytes: 16 });
  const pointer = await f.value.render('pointer', '14', { kind: 'value', value: 0x1000n });
  assert.equal(pointer.status, 'partial'); assert.equal(pointer.children[0].truncated, true);
  const invalid = await f.value.render('invalid', '14', { kind: 'value', value: 0x80000000n });
  assert.equal(invalid.children[0].children[0].status, 'invalid_memory');
  assert.equal(invalid.children[0].children[0].value, undefined);
  assert.equal((await f.value.render('null', '14', { kind: 'value', value: 0n })).children[0].status, 'null_pointer');
  const small = reader(metadata(), { max_bytes: 16 });
  for (const address of [0x1000n, 0x1008n, 0x1010n]) await small.value.render('wide', '11', { kind: 'address', value: address });
  assert.equal(small.value.bytes, 16); assert.equal(small.calls.length, 2);
  const exhausted = await small.value.render('wide', '11', { kind: 'address', value: 0x1010n });
  assert.equal(exhausted.status, 'memory_budget'); assert.equal(exhausted.value, undefined);
  const unknown = reader(); unknown.meta.types['13'].members[0].status = 'unsupported_bitfield';
  assert.equal((await unknown.value.render('pair', '13', { kind: 'address', value: 0x1000n })).children[0].status, 'unsupported_bitfield');
  const collapsed = reader(metadata(), { max_depth: 0 });
  assert.equal((await collapsed.value.render('pair', '13', { kind: 'address', value: 0x1000n })).truncated, true);
  const many = metadata(); many.types['12'].count = 100;
  const bounded = reader(many, { max_nodes: 16, max_children: 32 });
  const array = await bounded.value.render('large', '12', { kind: 'address', value: 0x1000n });
  assert.equal(array.children.length, 15); assert.equal(array.truncated, true); assert.equal(bounded.value.nodes, 16);
});

async function pipeline(t, override = () => undefined) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcsx2-vars-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const elf = path.join(directory, 'variables.elf'), data = Buffer.alloc(512);
  data.set(Buffer.from('7f454c4601010100', 'hex')); data.writeUInt16LE(2, 16); data.writeUInt16LE(8, 18); data.writeUInt32LE(1, 20);
  data.writeUInt32LE(0x100000, 24); data.writeUInt32LE(52, 28); data.writeUInt32LE(128, 32);
  data.writeUInt16LE(52, 40); data.writeUInt16LE(32, 42); data.writeUInt16LE(1, 44);
  data.writeUInt16LE(40, 46); data.writeUInt16LE(3, 48); data.writeUInt16LE(1, 50);
  data.writeUInt32LE(1, 52); data.writeUInt32LE(0x100000, 60); data.writeUInt32LE(128, 68); data.writeUInt32LE(128, 72); data.writeUInt32LE(5, 76);
  data.writeUInt32LE(1, 168); data.writeUInt32LE(3, 172); data.writeUInt32LE(300, 184); data.writeUInt32LE(40, 188);
  data.writeUInt32LE(11, 208); data.writeUInt32LE(1, 212); data.writeUInt32LE(350, 224); data.writeUInt32LE(16, 228);
  Buffer.from('\0.shstrtab\0.debug_line\0').copy(data, 300); await fs.writeFile(elf, data);
  const identity = await inspectSourceElf(elf), meta = metadata(); meta.sha256 = identity.sha256;
  const caps = { ...capabilities, elf: 'host:' + elf, elf_crc: identity.elf_crc, execution_epoch: 1, features: ['variable_inspection'] };
  const gpr = Array.from({ length: 32 }, () => hex(0).slice(2)); gpr[4] = hex(23).slice(2);
  const { client, mock } = await workflowFixture(t, request => {
    const result = override(request, caps, gpr); if (result !== undefined) return result;
    if (request.cmd === 'capabilities') return caps;
    if (request.cmd === 'inspect_ee') return { ok: true, revision: 8, execution_epoch: 1, pc: meta.pc, gpr,
      ...(request.address ? { memory: { address: request.address, length: request.length, valid: false, reason: 'invalid_memory' } } : {}) };
  });
  const inspector = new SourceVariables({ runner: async () => JSON.stringify(meta) });
  return { client, mock, inspector, meta, identity, caps, gpr };
}

test('variable tool pipeline guards identity/state, returns raw storage, and sends read-only commands', async t => {
  const f = await pipeline(t), result = await f.inspector.inspect(f.client, {});
  assert.equal(result.variables[0].value, '23'); assert.equal(result.variables[0].register, 4);
  assert.equal(result.snapshot.gpr[4], hex(23)); assert.equal(result.read_only, true);
  assert.ok(f.mock.requests.every(item => ['capabilities', 'inspect_ee'].includes(item.cmd)));
  assert.ok(f.mock.requests.slice(2).filter(item => item.cmd === 'inspect_ee').every(item => item.expected_revision === 8));
  f.meta.location_guard = 'prologue';
  const entry = await f.inspector.inspect(f.client, {});
  assert.equal(entry.variables[0].status, 'unavailable_during_prologue'); assert.equal(entry.variables[0].value, undefined);
  f.meta.location_guard = 'compiler_reported'; f.meta.variables[0].location = { status: 'location_unavailable' };
  assert.equal((await f.inspector.inspect(f.client, {})).variables[0].status, 'location_unavailable');
});

test('changed pause revision/registers, hash mismatch and cancellation discard the result rather than mixing states', async t => {
  const f = await pipeline(t, request => request.cmd === 'inspect_ee' && request.expected_revision !== undefined
    ? { ok: false, error: 'Paused inspection state changed' } : undefined);
  await assert.rejects(f.inspector.inspect(f.client, {}), /state changed/);
  const regs = await pipeline(t, (request, _caps, gpr) => {
    if (request.expected_revision !== undefined) gpr[4] = hex(99).slice(2);
  });
  await assert.rejects(regs.inspector.inspect(regs.client, {}), /registers changed/);
  const wrong = await pipeline(t);
  await assert.rejects(wrong.inspector.inspect(wrong.client, { expected_sha256: '0'.repeat(64) }), /SHA256/);
  await assert.rejects(wrong.inspector.inspect(wrong.client, { frame_index: 1 }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(wrong.inspector.inspect(wrong.client, {}, controller.signal), /abort/i);
});
