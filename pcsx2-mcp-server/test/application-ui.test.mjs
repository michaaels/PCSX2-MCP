import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ApplicationUIClient, defaultUIPort } from '../dist/application-ui.js';
import { registerApplicationUITools } from '../dist/application-ui-tools.js';

const uuid = '11111111-1111-4111-8111-111111111111';
const operation = '22222222-2222-4222-8222-222222222222';
const identity = { protocol_version: 1, service_id: uuid, process_id: 123, ui_port: 21513,
  data_directory: '/fixture', scope: 'pcsx2_qt_application' };
function fixture() {
  const clients = [];
  const client = new ApplicationUIClient(value => {
    const backend = { live: false, calls: [], handler: async command => command === 'ui_status' ? { features: ['ui_without_vm'] } : {},
      connect: async () => { backend.live = true; }, disconnect: () => { backend.live = false; }, isConnected: () => backend.live,
      applicationUICommand: async (command, input) => { backend.calls.push({ command, input }); return { ok: true, identity: { ...identity, ui_port: value }, ...await backend.handler(command, input) }; } };
    clients.push(backend); return backend;
  });
  return { client, clients, connect: () => client.connect({ ui_port: 21513, expected_process_id: 123, expected_data_directory: '/fixture' }) };
}

test('UI port follows the frontend environment without silently wrapping invalid ports', () => {
  assert.equal(defaultUIPort({}), 21513); assert.equal(defaultUIPort({ PCSX2_DEBUG_PORT: '32000' }), 21513);
  assert.equal(defaultUIPort({ PCSX2_UI_PORT: '40000', PCSX2_DEBUG_PORT: '32000' }), 40000);
  assert.equal(defaultUIPort({ PCSX2_DEBUG_PORT: '65535' }), 21513);
  for (const env of [{ PCSX2_UI_PORT: '65536' }, { PCSX2_UI_PORT: '0' }, { PCSX2_UI_PORT: 'abc' }]) assert.throws(() => defaultUIPort(env));
});

test('UI handshake pins process/port/data root; native errors and invalid peers cannot leave a connected client', async () => {
  const f = fixture(); await f.connect(); assert.equal(f.client.isConnected(), true);
  await assert.rejects(f.client.connect({ ui_port: 21513, expected_process_id: 999 }), /mismatch/);
  assert.equal(f.client.isConnected(), false); assert.ok(f.clients.every(value => !value.live));
  await f.connect(); f.clients.at(-1).handler = async () => ({ ok: false, error: 'UI refused' });
  await assert.rejects(f.client.status(), /UI refused/);
  f.clients.at(-1).handler = async () => ({ identity: { ...identity, service_id: operation } });
  await assert.rejects(f.client.status(), /identity changed/); assert.equal(f.client.isConnected(), false);
});

test('late requests cannot migrate into a reconnected UI service or return an old result', async () => {
  const f = fixture(); await f.connect();
  let release, started;
  const ready = new Promise(ok => { started = ok; });
  f.clients[0].handler = async () => { started(); return new Promise(ok => { release = ok; }); };
  const pending = f.client.status(); await ready;
  await f.connect(); release({});
  await assert.rejects(pending, /connection changed/); assert.equal(f.client.isConnected(), true);
  assert.equal(f.clients[0].live, false); assert.equal(f.clients[1].calls.length, 1);
});

test('UI action validation refuses missing fields, malformed handles and UTF-8 overflow before dispatch', async () => {
  const f = fixture(); await f.connect(); const backend = f.clients[0], before = backend.calls.length;
  const base = { snapshot_id: uuid, control_id: 'c1' };
  for (const input of [{ action: 'set_text' }, { action: 'set_checked' }, { action: 'set_check_state' }, { action: 'select_index' }, { action: 'set_value' }, { action: 'key' },
    { action: 'wheel', x: 1, y: 2 }, { action: 'wheel', x: 1, y: 2, delta_y: 1201 },
    { action: 'set_text', text: 'é'.repeat(8193) }, { action: 'click', control_id: 'foreign-id' }, { action: 'invoke_method' },
    { action: 'key', key: 'A', text: 'a'.repeat(33) }])
    await assert.rejects(f.client.action({ ...base, ...input }));
  assert.equal(backend.calls.length, before);
});

test('UI actions retain queued/running receipts and never replay a mutation while polling', async () => {
  const f = fixture(); await f.connect(); const backend = f.clients[0]; let polls = 0;
  backend.handler = async (command, input) => {
    assert.equal(input.expected_service_id, uuid); assert.equal(input.expected_process_id, 123);
    if (command === 'ui_action') {
      assert.ok(input.deadline_ms > Date.now() && input.deadline_ms <= Date.now() + 5000);
      return { action: { action_id: operation, state: 'queued', action: 'click' } };
    }
    ++polls; return { action: { action_id: operation, state: polls === 1 ? 'running' : 'completed', action: 'click' } };
  };
  const queued = await f.client.action({ snapshot_id: uuid, control_id: 'c1', action: 'click' });
  assert.equal(queued.action.state, 'queued');
  assert.match(queued.interpretation, /not proof/);
  const done = await f.client.actionStatus({ action_id: operation, wait_ms: 200 }); assert.equal(done.action.state, 'completed');
  assert.equal(backend.calls.filter(value => value.command === 'ui_action').length, 1);
  assert.equal(polls, 2);
});

test('UI snapshots enforce control bounds; screenshots reject a substituted window before returning image content', async () => {
  const f = fixture(); await f.connect(); const backend = f.clients[0];
  backend.handler = async () => ({ snapshot_id: uuid, created_at_ms: 1, expires_at_ms: 2, window_id: uuid, windows: [],
    controls: [{ id: 'c0', parent_id: '', class: 'QWidget', kind: 'widget', actions: [] }], truncated: false });
  assert.equal((await f.client.snapshot({ max_nodes: 1 })).controls.length, 1);
  await assert.rejects(f.client.snapshot({ max_nodes: 0 }));
  backend.handler = async () => ({ window_id: operation });
  await assert.rejects(f.client.screenshot({ snapshot_id: uuid, window_id: uuid }), /window identity mismatch/);
});

test('seven GUI MCP tools expose independent connection, bounded schemas and honest error channels', async () => {
  const registered = new Map(), f = fixture();
  const close = registerApplicationUITools({ tool: (name, description, shape, handler) => { assert.ok(!registered.has(name)); registered.set(name, { shape, handler }); } }, f.client);
  assert.equal(registered.size, 7);
  const call = async (name, input = {}) => { const tool = registered.get('pcsx2_ui_' + name); return tool.handler(z.object(tool.shape).parse(input)); };
  assert.equal((await call('status')).isError, true);
  assert.ok(!(await call('connect', { ui_port: 21513 })).isError);
  assert.equal((await call('action', { snapshot_id: uuid, control_id: 'c1', action: 'set_text' })).isError, true);
  await assert.rejects(call('snapshot', { max_depth: 33 }));
  await call('disconnect'); assert.equal(f.client.isConnected(), false); close();
});
