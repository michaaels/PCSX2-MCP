// Real SMS transport acceptance. Start the project-owned Bridge/UDPFS services first.
// node test/project-transport-live.mjs <PCSX2> <manifest> <configured-data-root> <fresh-Bridge-JSONL> <new-output> <guest-IPv4>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isIPv4, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';

assert.equal(process.argv.length, 8);
const [executable, manifestPath, configured, journal, output] = process.argv.slice(2, 7).map(p => path.resolve(p));
const guestIP = process.argv[7]; assert.ok(isIPv4(guestIP));
const incidentMode = process.env.PCSX2_TRANSPORT_INCIDENT;
assert.ok(incidentMode === undefined || incidentMode === 'update_path_failed', 'Unsupported SMS incident recipe');
const waitMs = Number(process.env.PCSX2_TRANSPORT_TIMEOUT_MS ?? 45000);
assert.ok(Number.isInteger(waitMs) && waitMs >= 1000 && waitMs <= 60000, 'Transport wait must be 1000–60000 ms');
assert.equal(await fs.stat(journal).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; }), false,
  'Use a fresh isolated Bridge journal, not a previous session');
const manifest = JSON.parse(await fs.readFile(manifestPath));
await fs.mkdir(output);
const root = path.join(output, 'instance'); await fs.mkdir(path.join(root, 'inis'), { recursive: true });
const project = path.join(output, 'project'); await fs.mkdir(project);
const elf = path.join(project, path.basename(manifest.debug_elf));
await fs.copyFile(path.join(path.dirname(manifestPath), manifest.debug_elf), elf);
assert.equal(createHash('sha256').update(await fs.readFile(elf)).digest('hex'), manifest.elf_sha256);
const localManifest = path.join(project, 'manifest.json'); await fs.copyFile(manifestPath, localManifest);
// HostFs and IPCONFIG apply only to this private copy, never to the retained build.
await fs.writeFile(path.join(project, 'IPCONFIG.DAT'), `${guestIP} 255.255.255.0 ${guestIP}\r\n`, { flag: 'wx' });
let ini = await fs.readFile(path.join(configured, 'inis', 'PCSX2.ini'), 'utf8');
function settings(section, values) {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\[${escaped}\\][^]*?(?=^\\[|(?![^]))`, 'm');
  const prior = ini.match(pattern)?.[0] ?? `[${section}]\n`;
  let updated = prior;
  for (const [key, value] of Object.entries(values)) {
    const line = new RegExp(`^${key}\\s*=.*$`, 'm');
    updated = line.test(updated) ? updated.replace(line, `${key} = ${value}`) : updated.trimEnd() + `\n${key} = ${value}\n`;
  }
  ini = pattern.test(ini) ? ini.replace(pattern, updated + '\n') : ini + '\n' + updated + '\n';
}
settings('EmuCore', { EnableHostFs: 'true' });
settings('DEV9/Eth', { EthEnable: 'true', EthApi: 'Sockets', EthDevice: 'Auto', InterceptDHCP: 'true' });
settings('Logging', { EnableEEConsole: 'true', EnableIOPConsole: 'true' });
await fs.writeFile(path.join(root, 'inis', 'PCSX2.ini'), ini);
const reservation = createServer();
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const mcp = new Client({ name: 'project-transport-live', version: '1.0' });
const inspector = new DebugServerClient('127.0.0.1', port);
const result = { started_at: new Date().toISOString(), build_id: manifest.build_id, elf_sha256: manifest.elf_sha256,
  client: 'actual SMS debug ELF', synthetic_receipts: false, hardware: 'not_tested', checks: [], passed: false };
const options = { manifest_path: localManifest, elf_path: elf, output_directory: output };
let owned = false;
async function call(name, args = {}) {
  const response = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  assert.ok(!response.isError, `MCP ${name} failed (details retained privately)`);
  return JSON.parse(response.content[0].text);
}
async function bridgeRows() {
  let file;
  try {
    file = await fs.open(journal, 'r');
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    assert.ok(bytesRead < buffer.length, 'Fresh Bridge journal exceeds 2 MiB');
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/).filter(Boolean);
    assert.ok(lines.length <= 4096 && lines.every(line => Buffer.byteLength(line) <= 2048), 'Bridge journal line bounds exceeded');
    // A concurrent append can leave an incomplete final line; retry the next poll.
    if (bytesRead && buffer[bytesRead - 1] !== 10) return [];
    return lines.map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  } finally { await file?.close(); }
}
function passed(message) { result.checks.push(message); console.log('PASS ' + message); }
try {
  await mcp.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port) }, stderr: 'pipe' }));
  const launch = await call('pcsx2_launch', { executable, elf, data_directory: root }); owned = true;
  assert.equal(launch.sha256, manifest.elf_sha256); await inspector.connect();
  if (incidentMode) {
    const { captureUpdateIncident } = await import('./project-incident-support.mjs');
    result.incident = await captureUpdateIncident({ call, inspector, manifest, manifestPath, elf, output, options, waitMs, passed });
  }
  const deadline = performance.now() + waitMs;
  let captured, matching = [], catalogSeenAt;
  while (performance.now() < deadline) {
    if ((await inspector.getCapabilities()).elf_crc !== manifest.pcsx2_crc) { await delay(200); continue; }
    captured = await call('pcsx2_diagnostics_collect', options); result.capture = captured;
    const rows = await bridgeRows();
    matching = rows.filter(row => row.buildId === manifest.build_id && captured.observed_boot_ids.includes(row.bootId));
    if (matching.some(row => row.event === 'catalog_open')) {
      catalogSeenAt ??= performance.now();
      if (performance.now() - catalogSeenAt >= 3000) break;
    }
    await delay(1000);
  }
  assert.ok(captured, 'No matching project ELF observed before deadline');
  const capture = JSON.parse(await fs.readFile(captured.artifact.path));
  result.observed_console = capture.client_logs;
  result.fresh_bridge_events = matching.length;
  result.observed_error_events = capture.client_logs.filter(log => log.level === 'ERROR');
  passed('retained SMS ELF hash/CRC and native process identity verified in a private instance');
  assert.ok(matching.length > 0, 'No fresh SMS build/boot receipt persisted by Bridge before deadline');
  const boots = [...new Set(matching.map(row => row.bootId))]; assert.equal(boots.length, 1);
  result.boot_id = boots[0];
  // An exclusively created snapshot avoids correlating an actively appended journal.
  const snapshot = path.join(output, 'bridge-snapshot.jsonl');
  await fs.writeFile(snapshot, matching.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  const associated = await call('pcsx2_diagnostics_correlate', { ...options,
    capture_path: captured.artifact.path, capture_sha256: captured.artifact.sha256,
    bridge_log_path: snapshot, boot_id: boots[0] }); result.correlation = associated;
  assert.ok(associated.matched_events > 0);
  assert.equal(associated.matched_events, associated.client_events, 'Every selected Bridge event must have an exact console match');
  assert.equal(associated.clocks.uncertainty, 'unbounded');
  assert.equal(associated.clocks.transport_latency_ms, null);
  passed('fresh SMS console fields match actual persisted UDPFS/Bridge receipts for the same build and boot');
  assert.ok(matching.some(row => row.event === 'boot'));
  assert.ok(matching.some(row => row.event === 'network_ready'));
  assert.ok(matching.some(row => row.event === 'catalog_open'));
  if (result.incident) {
    assert.equal(result.incident.boot_id, boots[0]);
    const events = matching.filter(row => row.event === result.incident.event && row.level === 'ERROR');
    assert.equal(events.length, 1, 'Incident requires exactly one matching persisted error in this boot');
    const console = capture.client_logs.filter(log => log.event === result.incident.event && log.client_session === boots[0]
      && log.client_sequence === events[0].sequence && log.level === events[0].level);
    assert.equal(console.length, 1);
    result.incident.join = { boot_id: boots[0], client_sequence: events[0].sequence,
      native_log_sequence: console[0].native_sequence, correlation_sha256: associated.artifact.sha256,
      relation: 'guard_then_logger_argument_then_exact_console_and_bridge_fields',
      replay_timing: 'debugger_pauses_perturb_execution', e11_audio_causality: 'not_established' };
    passed('captured incident boot and logger argument join exactly one subsequent console/Bridge ERROR receipt in the same run');
  }
  passed('actual SMS boot, network-ready and catalog-open events received without synthetic log injection');
  if (process.env.PCSX2_AUDIO_FIXTURE) {
    const { capturePlaybackAudio } = await import('./project-playback-audio.mjs');
    result.playback_audio = await capturePlaybackAudio({ call, inspector, manifest, manifestPath, elf, output, options, journal,
      fixturePath: process.env.PCSX2_AUDIO_FIXTURE, bootId: boots[0], passed });
  }
  result.scope = { transport: 'fresh-SMS-UDPFS-Bridge-client-events', jellyfin: 'validate-separately-in-service-receipt',
    catalog_contents: 'not_independently_compared', playback: 'not_tested', root_cause: 'not_established' };
  result.passed = true;
} catch (error) {
  // Never emit raw emulator/transport logs or source URLs on failures.
  result.failure = error instanceof assert.AssertionError ? error.message : 'Live transport operation failed; inspect private evidence';
  console.log('OBSERVED ' + result.failure); process.exitCode = 1;
} finally {
  inspector.disconnect();
  if (owned) {
    try {
      const stopped = await call('pcsx2_stop'); assert.equal(stopped.stopped, true);
      result.owned_emulator_stopped = true;
      passed('owned emulator stopped through its MCP; external instances remain outside cleanup');
    } catch {
      result.owned_emulator_stopped = false; result.passed = false; process.exitCode = 1;
    }
  }
  await mcp.close(); result.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(result, null, 2));
}
