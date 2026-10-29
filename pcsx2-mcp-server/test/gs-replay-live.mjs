// node test/gs-replay-live.mjs <PCSX2> <static dump report> <dynamic dump report>
//   <configured root> <new output> <exact D3D11 adapter> [another adapter ...]
// Reports are gs-dump-live validation.json files with closed, verified artifacts.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { verifyDump } from '../dist/gs-dump.js';

assert.ok(process.argv.length >= 8, 'Expected emulator, two reports, configured root, new output and exact adapter');
const [executable, staticReport, dynamicReport, configured, output] = process.argv.slice(2, 7).map(p => path.resolve(p));
const adapters = process.argv.slice(7);
assert.equal(new Set(adapters).size, adapters.length, 'Duplicate adapters');
assert.ok(adapters.every(v => v.length > 0 && !/[\r\n]/.test(v)), 'Invalid adapter');
await fs.mkdir(output);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const nativeHash = hash(await fs.readFile(executable));
const originalIni = await fs.readFile(path.join(configured, 'inis/PCSX2.ini'), 'utf8');
const result = { kind: 'd3d11_gs_replay_acceptance', executable, native_sha256: nativeHash,
  started_at: new Date().toISOString(), checks: [], dumps: {}, cases: [], passed: false,
  SMS_or_Jellyfin_involved: false, physical_validation: 'not_performed' };
const passed = text => { result.checks.push(text); console.log('PASS ' + text); };
async function freePort() {
  const server = createServer();
  await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
  const port = server.address().port;
  await new Promise(ok => server.close(ok));
  return port;
}
function iniFor(adapter) {
  // Replace only the private GS section; preserve other settings and the user's root.
  const match = /^\[EmuCore\/GS\]\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(originalIni);
  const body = (match?.[1] ?? '').replace(/^(?:Renderer|Adapter)\s*=.*(?:\r?\n|$)/gm, '');
  const section = '[EmuCore/GS]\nRenderer = 3\nAdapter = ' + adapter + '\n' + body;
  return match ? originalIni.slice(0, match.index) + section + originalIni.slice(match.index + match[0].length)
    : originalIni + '\n' + section;
}
async function stopOwned(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((ok, no) => {
    const timer = setTimeout(() => no(new Error('Owned replay did not stop')), 5000);
    child.once('exit', () => { clearTimeout(timer); ok(); });
    child.kill();
  });
}
try {
  for (const [name, filename] of [['static', staticReport], ['dynamic', dynamicReport]]) {
    const report = JSON.parse(await fs.readFile(filename, 'utf8'));
    assert.equal(report.completed.state, 'closed');
    assert.equal(report.completed.artifact.verified, true);
    const dump = report.completed.path;
    const verified = await verifyDump(dump, 64 * 1024 * 1024, 30);
    assert.equal(verified.sha256, report.completed.artifact.sha256);
    const bytes = await fs.readFile(dump);
    assert.equal(hash(bytes), verified.sha256);
    let offset = 8 + bytes.readUInt32LE(4) + bytes.readUInt32LE(12) + 8192;
    const packets = { transfer: 0, vsync: 0, fifo: 0, registers: 0 };
    while (offset < bytes.length) {
      const kind = bytes[offset++];
      if (kind === 0) { packets.transfer++; offset += 5 + bytes.readUInt32LE(offset + 1); }
      else if (kind === 1) { packets.vsync++; offset++; }
      else if (kind === 2) { packets.fifo++; offset += 4; }
      else if (kind === 3) { packets.registers++; offset += 8192; }
      else throw new Error('Unexpected GS packet ' + kind);
    }
    assert.equal(offset, bytes.length);
    assert.equal(packets.vsync, verified.vsync_packets);
    result.dumps[name] = { report: filename, report_sha256: hash(await fs.readFile(filename)), path: dump, ...verified, packets };
  }
  assert.equal(result.dumps.static.packets.transfer, 0, 'Static baseline must have no GIF transfers');
  assert.ok(result.dumps.dynamic.packets.transfer > 0, 'Dynamic fixture must supply real GIF transfers');
  passed('closed hash-verified static/dynamic dumps differ in actual GIF traffic without modifying either artifact');
  for (const [index, adapter] of adapters.entries()) for (const name of ['static', 'dynamic']) {
    const directory = path.join(output, 'adapter-' + index + '-' + name);
    await fs.mkdir(path.join(directory, 'inis'), { recursive: true });
    await fs.writeFile(path.join(directory, 'inis/PCSX2.ini'), iniFor(adapter));
    const port = await freePort(), client = new DebugServerClient('127.0.0.1', port);
    const child = spawn(executable, ['-portable', '-nogui', result.dumps[name].path], {
      cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore',
      env: { ...process.env, PCSX2_DEBUG_PORT: String(port), PCSX2_MCP_DATA_DIR: directory } });
    const observed = { adapter, dump: name, pid: child.pid, directory, attempts: [], image: false, owned_emulator_stopped: false };
    result.cases.push(observed);
    let spawnError; child.once('error', error => { spawnError = error; });
    try {
      for (let attempt = 0; ; attempt++) {
        if (spawnError) throw spawnError;
        assert.equal(child.exitCode, null, 'Replay exited before readiness');
        try {
          await client.connect();
          const caps = await client.getCapabilities();
          assert.equal(caps.process_id, child.pid);
          assert.equal(caps.debug_port, port);
          assert.equal(path.normalize(caps.data_directory), path.normalize(directory));
          observed.capabilities = caps;
          break;
        } catch (error) { client.disconnect(); if (attempt >= 79) throw error; await delay(100); }
      }
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const image = await client.captureScreenshot();
          const bytes = Buffer.from(image.data, 'base64');
          assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
          assert.ok(image.width > 0 && image.height > 0);
          const filename = path.join(directory, 'replayed.png');
          await fs.writeFile(filename, bytes);
          Object.assign(observed, { image: true, width: image.width, height: image.height, screenshot: filename, screenshot_sha256: hash(bytes) });
          break;
        } catch (error) {
          // A transport/renderer/encoding failure must never satisfy the missing-frame case.
          assert.match(String(error), /Screenshot failed: No rendered frame available\./);
          observed.attempts.push(String(error)); await delay(200);
        }
      }
      observed.status = await client.getStatus();
      assert.equal(observed.status.paused, false);
      assert.equal(observed.image, name === 'dynamic', 'Unexpected replay frame availability');
    } finally {
      client.disconnect();
      if (!spawnError) await stopOwned(child);
      observed.owned_emulator_stopped = child.exitCode !== null || child.signalCode !== null;
    }
    const logPath = path.join(directory, 'logs/emulog.txt'), log = await fs.readFile(logPath, 'utf8');
    observed.actual_adapter = log.split(/\r?\n/).find(v => v.includes('D3D11: Adapter:'));
    observed.log = logPath; observed.log_sha256 = hash(Buffer.from(log));
    assert.equal(observed.actual_adapter?.split('D3D11: Adapter: ')[1], adapter, 'Requested D3D11 adapter was not used');
    assert.equal(observed.owned_emulator_stopped, true);
    passed(adapter + ': ' + name + ' replay has the expected frame availability on the explicitly selected D3D11 device');
    passed(adapter + ': ' + name + ' replay has an isolated native identity and its owned process is stopped');
  }
  for (const item of Object.values(result.dumps)) assert.equal(hash(await fs.readFile(item.path)), item.sha256);
  assert.equal(hash(await fs.readFile(executable)), nativeHash);
  passed('both dumps and the native executable retain their original hashes after every replay');
  result.passed = true;
} catch (error) { result.failure = String(error); throw error; }
finally {
  result.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(result, null, 2) + '\n');
}
