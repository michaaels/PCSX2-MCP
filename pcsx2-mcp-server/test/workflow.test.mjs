import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ScenarioRunner } from '../dist/scenario.js';
import { workflowFixture, capabilities } from './workflow-fixtures.mjs';

async function directoryFor(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcsx2-workflow-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory;
}

test('native symbol wrappers preserve pagination, source file and address offsets', async t => {
  const { client, mock } = await workflowFixture(t);
  assert.equal((await client.lookupSymbols({ query: 'main', exact: true })).symbols[0].source_file, 'main.c');
  assert.equal((await client.importSymbols()).requested, true);
  assert.equal((await client.resolveAddress('00100008')).symbols[0].offset, 8);
  assert.equal((await client.setSymbolBreakpoint('main')).address, '0x00100000');
  assert.equal(mock.requests.at(-1).cmd, 'breakpoint_symbol');
  await client.readMemoryStrict('00100000', 1);
  assert.equal(mock.requests.at(-1).address, '0x00100000');
  await assert.rejects(client.lookupSymbols({ offset: -1 }));
  await assert.rejects(client.resolveAddress('0x100000000'));
});

test('scenario executes typed assertions and saves recipe, PNG, context and report', async t => {
  const { client } = await workflowFixture(t);
  const result = await new ScenarioRunner().run(client, { name: 'boot', expected_elf_crc: '12345678', steps: [
    { action: 'frames', frames: 7 }, { action: 'input', buttons: ['cross'], frames: 2 },
    { action: 'assert_memory', address: '0x100000', expected_hex: 'abab' },
    { action: 'assert_expression', expression: 'v0', equals: '18446744073709551615' },
    { action: 'assert_log', contains: 'SMS ready' }, { action: 'assert_controller' },
    { action: 'run_to_symbol', symbol: 'main' }, { action: 'screenshot' }, { action: 'context' },
  ] }, await directoryFor(t));
  assert.equal(result.passed, true);
  assert.equal(result.final_paused, true);
  assert.equal(result.steps.length, 9);
  const files = await fs.readdir(result.artifacts.directory);
  assert.ok(files.includes('scenario.json'));
  assert.ok(files.includes('report.json'));
  assert.ok(files.includes('step-008.png'));
  assert.ok(files.includes('step-009-context.json'));
  assert.equal(JSON.parse(await fs.readFile(result.artifacts.report, 'utf8')).passed, true);
  assert.equal((await client.listBreakpoints()).length, 0);
});

test('failed assertion stops subsequent steps and saves diagnostic context', async t => {
  const { client, mock } = await workflowFixture(t);
  const result = await new ScenarioRunner().run(client, { name: 'bad-memory', steps: [
    { action: 'assert_memory', address: '0x100000', expected_hex: 'ff' }, { action: 'frames', frames: 10 },
  ] }, await directoryFor(t));
  assert.equal(result.passed, false);
  assert.match(result.steps[0].error, /Memory mismatch/);
  assert.equal(result.steps.length, 1);
  assert.ok(!mock.requests.some(request => request.cmd === 'frame_advance'));
  assert.ok(result.diagnostic.report);
  assert.equal(result.final_paused, true);
});

test('wrong CRC and malformed recipes are rejected before changing VM state', async t => {
  const { client, mock } = await workflowFixture(t);
  const runner = new ScenarioRunner(); const directory = await directoryFor(t);
  const result = await runner.run(client, { name: 'wrong-build', expected_elf_crc: '0', steps: [{ action: 'frames' }] }, directory);
  assert.equal(result.passed, false);
  assert.ok(!mock.requests.some(request => request.cmd === 'pause'));
  await assert.rejects(runner.run(client, { name: 'invalid', steps: [{ action: 'shell', command: 'ignored' }] }, directory));
  await assert.rejects(runner.run(client, { name: 'invalid', steps: [{ action: 'frames', unrecognized: true }] }, directory));
});

test('identity changes stop the scenario before the next action', async t => {
  let calls = 0;
  const { client, mock } = await workflowFixture(t, request => request.cmd === 'capabilities' && ++calls >= 2 ? { ...capabilities, elf_crc: '0x87654321' } : undefined);
  const result = await new ScenarioRunner().run(client, { name: 'changed', steps: [{ action: 'frames' }] }, await directoryFor(t));
  assert.equal(result.passed, false);
  assert.match(result.error, /identity changed/);
  assert.ok(!mock.requests.some(request => request.cmd === 'frame_advance'));
  assert.equal(mock.requests.filter(request => request.cmd === 'pause').length, 1);
  assert.ok(!mock.requests.some(request => request.cmd === 'capture_context'));
});

test('existing target breakpoints are preserved and not removed', async t => {
  const { client, mock } = await workflowFixture(t);
  await client.setBreakpoint('0x00100000');
  const result = await new ScenarioRunner().run(client, { name: 'conflict', steps: [{ action: 'run_to_symbol', symbol: 'main' }] }, await directoryFor(t));
  assert.equal(result.passed, false);
  assert.match(result.error, /already exists/);
  assert.ok(!mock.requests.some(request => request.cmd === 'remove_breakpoint'));
});

test('cancelled scenario saves failure report, releases exclusivity and confirms pause', async t => {
  const controller = new AbortController();
  const { client } = await workflowFixture(t, request => { if (request.cmd === 'evaluate') controller.abort(new Error('Cancelled test')); });
  const result = await new ScenarioRunner().run(client, { name: 'cancel', steps: [
    { action: 'assert_expression', expression: '0', equals: '0xffffffffffffffff' },
  ] }, await directoryFor(t), { signal: controller.signal });
  assert.equal(result.passed, false);
  assert.equal(result.final_paused, true);
  assert.ok(result.diagnostic.report);
  assert.equal((await client.getStatus()).paused, true);
});

test('scenario connection ownership rejects concurrent calls but permits its own operations', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { client } = await workflowFixture(t);
  const exclusive = client.withExclusiveSession(async () => { await gate; return client.getStatus(); });
  await assert.rejects(client.getStatus(), /scenario owns/);
  release(); assert.equal((await exclusive).alive, true);
  assert.equal((await client.getStatus()).alive, true);
});

test('missing history and screenshot mismatches never pass silently', async t => {
  let logs = 0;
  const { client } = await workflowFixture(t, request => {
    if (request.cmd === 'read_logs' && ++logs > 1) return { ok: true, session: 1, oldest_sequence: 10, dropped: true, next_cursor: 10, logs: [] };
  });
  const runner = new ScenarioRunner(); const directory = await directoryFor(t);
  const missing = await runner.run(client, { name: 'log-gap', steps: [{ action: 'assert_log', contains: 'ready' }] }, directory);
  assert.match(missing.error, /overwritten/);
  const mismatch = await runner.run(client, { name: 'image-mismatch', steps: [{ action: 'screenshot', expected_sha256: '0'.repeat(64) }] }, directory);
  assert.equal(mismatch.passed, false);
  assert.match(mismatch.error, /SHA256 mismatch/);
  assert.ok((await fs.readdir(mismatch.artifacts.directory)).includes('step-001.png'));
});

test('memory assertions reject fabricated zeros at invalid addresses', async t => {
  const { client } = await workflowFixture(t, request => request.cmd === 'read_memory'
    ? { ok: true, hex: '00', invalid_bytes: 1 } : undefined);
  const result = await new ScenarioRunner().run(client, { name: 'invalid-memory', steps: [
    { action: 'assert_memory', address: '0xffffffff', expected_hex: '00' },
  ] }, await directoryFor(t));
  assert.equal(result.passed, false);
});

test('deadline is reported as failure after an in-flight command and cleanup confirms pause', async t => {
  const { client } = await workflowFixture(t, async request => {
    if (request.cmd === 'evaluate') await new Promise(resolve => setTimeout(resolve, 20));
  });
  const result = await new ScenarioRunner().run(client, { name: 'deadline', steps: [
    { action: 'assert_expression', expression: '0', equals: '0xffffffffffffffff' },
  ] }, await directoryFor(t), { timeoutMs: 1 });
  assert.equal(result.passed, false);
  assert.match(result.error, /deadline/);
  assert.equal(result.final_paused, true);
});

test('failure to confirm final pause invalidates an otherwise successful report', async t => {
  const { client } = await workflowFixture(t, request => request.cmd === 'status'
    ? { ok: true, data: { alive: true, paused: false, pc: '0x100000', cycles: 0 } } : undefined);
  const result = await new ScenarioRunner().run(client, { name: 'cleanup', steps: [{ action: 'frames' }] }, await directoryFor(t));
  assert.equal(result.steps[0].passed, true);
  assert.equal(result.passed, false);
  assert.equal(result.final_paused, false);
  assert.match(result.cleanup_error, /pause could not be confirmed/);
});
