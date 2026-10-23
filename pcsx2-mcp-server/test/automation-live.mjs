// Optional integration test; uses pcsx2_launch/stop to own only its test process.
// node test/automation-live.mjs <pcsx2-qt executable> <homebrew ELF> <artifacts>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';

const [executable, elf, output] = process.argv.slice(2).map(value => path.resolve(value));
assert.ok(executable && elf && output);
await fs.mkdir(output, { recursive: true });
const results = { executable, elf, started_at: new Date().toISOString(), checks: [] };
const mcp = new Client({ name: 'automation-live', version: '1.0' });
const inspector = new DebugServerClient();
let owns = false;
async function call(name, args = {}) {
  const result = await mcp.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result.content));
  return JSON.parse(result.content[0].text);
}
function passed(name) { results.checks.push(name); console.log('PASS ' + name); }
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], env: { ...process.env }, stderr: 'pipe' }));
  assert.equal((await mcp.callTool({ name: 'pcsx2_stop', arguments: {} })).isError, true);
  const failedStart = await mcp.callTool({ name: 'pcsx2_launch', arguments: { executable: process.execPath, elf } });
  assert.equal(failedStart.isError, true);
  passed('failed child startup leaves launcher ownership available for retry');
  results.launch = await call('pcsx2_launch', { executable, elf, ...(process.env.PCSX2_MCP_DATA_DIR ? { data_directory: process.env.PCSX2_MCP_DATA_DIR } : {}) });
  owns = true;
  assert.equal(results.launch.pid, results.launch.capabilities.process_id);
  assert.match(results.launch.sha256, /^[0-9a-f]{64}$/);
  passed('launches PCSX2 through MCP and verifies process/ELF identity');
  await inspector.connect();
  const other = new Client({ name: 'automation-other', version: '1.0' });
  try {
    await other.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], env: { ...process.env }, stderr: 'pipe' }));
    const busy = await other.callTool({ name: 'pcsx2_launch', arguments: { executable, elf } });
    assert.equal(busy.isError, true);
    assert.match(busy.content[0].text, /occupied/);
    assert.equal((await inspector.getStatus()).alive, true);
    assert.equal((await other.callTool({ name: 'pcsx2_stop', arguments: {} })).isError, true);
    passed('a second MCP refuses the occupied port and cannot stop the first emulator');
  } finally { await other.close(); }
  for (let attempt = 0; ; attempt++) {
    const capabilities = await inspector.getCapabilities();
    if (capabilities.elf && capabilities.elf_crc !== '0x00000000') break;
    assert.ok(attempt < 80, 'ELF did not boot'); await delay(250);
  }
  await delay(1500);
  await inspector.pause();
  for (const frames of [1, 7, 60]) {
    const result = await call('pcsx2_frame_advance', { frames });
    assert.equal(result.frames_advanced, frames);
    assert.equal(result.completed, true);
    assert.equal(result.paused, true);
    assert.equal(result.current_frame, result.start_frame + frames);
  }
  passed('advances exactly 1, 7 and 60 VSync boundaries and pauses');
  const initial = await inspector.getController();
  const input = call('pcsx2_input', { frames: 120, buttons: ['cross', 'right'], left_x: 0, left_y: 255, right_x: 200 });
  await delay(100);
  const held = await inspector.getController();
  assert.deepEqual(held.buttons, ['right', 'cross']);
  assert.equal(held.left_x, 0); assert.equal(held.left_y, 255); assert.equal(held.right_x, 200);
  const completedInput = await input;
  assert.equal(completedInput.completed, true);
  assert.deepEqual(await inspector.getController(), initial);
  passed('guest virtual controller holds digital/analog input then restores its prior state');

  const interrupted = call('pcsx2_input', { frames: 600, buttons: ['triangle'], left_x: 255 });
  // Interrupt via a second connection while the MCP call is still waiting.
  await delay(100); await inspector.pause();
  await assert.rejects(interrupted, /paused_early/);
  assert.deepEqual(await inspector.getController(), initial);
  passed('manual interruption restores the controller and reports incomplete execution');

  const operation = await inspector.startFrameAdvance(8, { buttons: ['start'] });
  const cancelled = await inspector.cancelAutomation(operation.operation_id);
  assert.equal(cancelled.reason, 'cancelled');
  assert.deepEqual(await inspector.getController(), initial);
  await inspector.resume(); await delay(300);
  assert.equal((await inspector.getStatus()).paused, false);
  await inspector.pause();
  passed('cancellation clears pending native frames without a delayed auto-pause');
  const timeout = await mcp.callTool({ name: 'pcsx2_input', arguments: { frames: 600, timeout_ms: 1, buttons: ['square'] } });
  assert.equal(timeout.isError, true);
  assert.match(timeout.content[0].text, /timed out/);
  assert.equal((await inspector.getStatus()).paused, true);
  assert.deepEqual(await inspector.getController(), initial);
  passed('tool timeout cancels the operation and restores controller/pause state');

  await inspector.setBreakpoint(results.launch.entry);
  await inspector.loadElf(elf);
  const breakpoint = await mcp.callTool({ name: 'pcsx2_input', arguments: { frames: 600, buttons: ['circle'] } });
  assert.equal(breakpoint.isError, true);
  assert.equal(JSON.parse(breakpoint.content[0].text).reason, 'paused_early');
  assert.equal((await inspector.getStatus()).pc, results.launch.entry);
  assert.deepEqual(await inspector.getController(), initial);
  await inspector.removeBreakpoint(results.launch.entry);
  await inspector.resume();
  for (let attempt = 0; ; attempt++) {
    try { await inspector.captureScreenshot(); break; }
    catch (error) { assert.ok(attempt < 80, error.message); await delay(250); }
  }
  await inspector.pause();
  passed('a real ELF-entry breakpoint interrupts automation and restores the controller');

  const capture = await mcp.callTool({ name: 'pcsx2_capture_context', arguments: { output_directory: output } });
  assert.ok(!capture.isError);
  assert.equal(capture.content[1].type, 'image');
  results.artifacts = JSON.parse(capture.content[0].text).artifacts;
  passed('captures context and rendered frame after controller automation');
  inspector.disconnect();
  assert.equal((await call('pcsx2_stop')).stopped, true); owns = false;
  assert.equal((await mcp.callTool({ name: 'pcsx2_stop', arguments: {} })).isError, true);
  passed('stops only its owned emulator and rejects a second stop');
  results.passed = true;
} finally {
  inspector.disconnect();
  if (owns) await mcp.callTool({ name: 'pcsx2_stop', arguments: {} }).catch(() => {});
  await mcp.close();
  results.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
}
