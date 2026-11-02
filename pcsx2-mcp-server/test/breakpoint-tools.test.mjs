import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { registerBreakpointTools } from '../dist/breakpoint-tools.js';

function tools(value) {
  const registered = new Map(), calls = [];
  const record = name => async (...args) => { calls.push({ name, args }); };
  const client = value ?? { isConnected: () => true, getCapabilities: async () => ({ features: ['atomic_point_conditions'] }),
    setBreakpoint: record('setBreakpoint'), removeBreakpoint: record('removeBreakpoint'), listBreakpoints: async cpu => { calls.push({ name: 'listBreakpoints', args: [cpu] }); return []; },
    setMemcheck: record('setMemcheck'), removeMemcheck: record('removeMemcheck'), listMemchecks: async cpu => { calls.push({ name: 'listMemchecks', args: [cpu] }); return []; } };
  registerBreakpointTools({ tool: (name, description, shape, handler) => { assert.ok(!registered.has(name)); registered.set(name, { shape, handler }); } }, () => client);
  return { calls, client, registered, call: async (name, args = {}) => {
    const entry = registered.get('pcsx2_' + name); assert.ok(entry);
    return entry.handler(z.object(entry.shape).parse(args));
  } };
}
const text = r => r.content[0].text;

test('six breakpoint/watchpoint MCP tools retain default EE and explicit IOP routing', async () => {
  for (const cpu of [undefined, 'iop']) {
    const t = tools(); assert.equal(t.registered.size, 6);
    const base = { address: '0x00100000', ...(cpu ? { cpu } : {}) };
    const r = await t.call('set_breakpoint', base); assert.ok(!r.isError);
    await t.call('list_breakpoints', cpu ? { cpu } : {}); await t.call('remove_breakpoint', base);
    await t.call('set_watchpoint', base); await t.call('list_watchpoints', cpu ? { cpu } : {}); await t.call('remove_watchpoint', base);
    const expected = cpu ?? 'ee';
    assert.equal(t.calls[0].args[1].cpu, expected); assert.equal(t.calls[1].args[0], expected); assert.equal(t.calls[2].args[1], expected);
    assert.equal(t.calls[3].args[1], '0x100004'); assert.equal(t.calls[3].args[2].cpu, expected);
    assert.equal(t.calls[4].args[0], expected); assert.equal(t.calls[5].args[2], expected);
    assert.equal(text(r), (cpu ? '[IOP] ' : '') + 'Breakpoint set at 0x00100000');
  }
});

test('old native condition capability refuses before either mutator; unconditional operations remain available', async () => {
  const t = tools(); t.client.getCapabilities = async () => ({ features: [] });
  for (const name of ['set_breakpoint', 'set_watchpoint']) {
    const r = await t.call(name, { address: '0x100000', condition: '(' });
    assert.equal(r.isError, true); assert.match(text(r), /Rebuild PCSX2.*atomic_point_conditions/);
  }
  assert.equal(t.calls.length, 0);
  assert.ok(!(await t.call('set_breakpoint', { address: '0x100000' })).isError);
  assert.equal(t.calls.length, 1);
});

test('native expression errors are returned as MCP errors, with the original condition and CPU forwarded', async () => {
  const t = tools(); let attempted;
  t.client.setBreakpoint = async (...args) => { attempted = args; throw new Error('Invalid breakpoint condition: unmatched parenthesis'); };
  const r = await t.call('set_breakpoint', { address: '0x100000', cpu: 'iop', condition: '(' });
  assert.equal(r.isError, true); assert.match(text(r), /Invalid breakpoint condition/);
  assert.equal(attempted[1].condition, '('); assert.equal(attempted[1].cpu, 'iop');
  t.client.setMemcheck = async () => { throw new Error('Invalid watchpoint condition'); };
  assert.equal((await t.call('set_watchpoint', { address: '0x100000', condition: '(' })).isError, true);
});

test('invalid CPU/condition bounds/addresses and backwards/overflowing ranges cannot reach native mutators', async () => {
  const t = tools();
  for (const args of [{ cpu: 'vu0' }, { condition: 'x'.repeat(4097) }, { condition: 'é'.repeat(2049) }, { address: 'symbol + 4' }, { address: '0x100000000' }])
    await assert.rejects(t.call('set_breakpoint', { address: '0x100000', ...args }));
  for (const args of [{ address: '0xfffffffc' }, { address: '0x100000', end: '0x100000' }, { address: '0x100000', end: '0x0' }])
    assert.equal((await t.call('set_watchpoint', args)).isError, true);
  assert.equal(t.calls.length, 0);
  assert.ok(!(await t.call('set_watchpoint', { address: '0x100000', end: '0x100010', type: 'onchange', action: 'both' })).isError);
  assert.equal(t.calls[0].args[1], '0x100010'); assert.equal(t.calls[0].args[2].type, 'onchange'); assert.equal(t.calls[0].args[2].action, 'both');
});

test('disconnected point tools fail without touching a foreign or absent session', async () => {
  const t = tools({ isConnected: () => false });
  for (const name of ['set_breakpoint', 'remove_breakpoint', 'list_breakpoints', 'set_watchpoint', 'remove_watchpoint', 'list_watchpoints']) {
    const r = await t.call(name, name.startsWith('list_') ? {} : { address: '0x100000' });
    assert.equal(r.isError, true); assert.match(text(r), /not connected/);
  }
});

test('point lists report supplied native conditions, max-hit and logging options without fabricating unsupported fields', async () => {
  const t = tools();
  t.client.listBreakpoints = async () => [{ address: '0x00100000', enabled: true, temporary: false, has_condition: true,
    condition: 't0 == 1', description: 'review', options_available: true, max_hits: 3, instrumentation_enabled: true,
    log_format: 'pc={pc}', continue_on_hit: true }];
  const r = text(await t.call('list_breakpoints', { cpu: 'iop' }));
  assert.match(r, /\[IOP\]/); assert.match(r, /cond: t0 == 1/); assert.match(r, /max hits: 3/); assert.match(r, /log: pc=\{pc\}; continue: true/);
  t.client.listMemchecks = async () => [{ start: '0x00100000', end: '0x00100004', hits: 2, last_pc: '0x00100200',
    has_condition: true, condition: 'v0 == 0', options_available: false }];
  const watch = text(await t.call('list_watchpoints'));
  assert.match(watch, /cond: v0 == 0/); assert.doesNotMatch(watch, /max hits:|log:/);
});
