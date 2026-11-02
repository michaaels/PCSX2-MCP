// node test/vscode-live.mjs <Code.exe> <PCSX2> <standalone fixture> <configured root> <new output> [extension.vsix]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DebugServerClient } from '../dist/debug-server-client.js';

assert.ok(process.argv.length === 7 || process.argv.length === 8);
const [code, executable, input, configured, output] = process.argv.slice(2).map(p => path.resolve(p));
await fs.mkdir(output);
const repository = fileURLToPath(new URL('../../', import.meta.url)), fixture = path.join(output, 'fixture'), root = path.join(output, 'native-data');
const digest = b => createHash('sha256').update(b).digest('hex');
const report = { kind: 'owned_VSCode_native_acceptance', passed: false, created_at: new Date().toISOString(),
  SMS_or_Jellyfin_involved: false, physical_validation: 'not_performed' };
let native, editor, installer, inspector, watchdog, logOverflow = false;
const logs = [];
function launch(command, args, options, filename) {
  const stream = createWriteStream(path.join(output, filename), { flags: 'wx' }); let bytes = 0;
  const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', data => {
    bytes += data.length; if (bytes <= 4 * 1024 ** 2) stream.write(data); else logOverflow = true;
  });
  child.once('close', () => stream.end()); logs.push({ stream, child }); return child;
}
try {
  await fs.cp(input, fixture, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'manifest.json')));
  assert.equal(manifest.kind, 'standalone_mcp_render_fixture');
  for (const [name, hash] of Object.entries(manifest.sha256)) { assert.equal(path.basename(name), name); assert.equal(digest(await fs.readFile(path.join(fixture, name))), hash); }
  const sources = fileURLToPath(new URL('./fixtures/standalone/', import.meta.url));
  for (const name of await fs.readdir(sources)) assert.equal(digest(await fs.readFile(path.join(sources, name))), manifest.sha256[name]);
  const iniPath = path.join(configured, 'inis/PCSX2.ini'), ini = await fs.readFile(iniPath); report.config_sha256 = digest(ini);
  await fs.mkdir(path.join(root, 'inis'), { recursive: true }); await fs.writeFile(path.join(root, 'inis/PCSX2.ini'), ini);
  const server = createServer(); await new Promise(ok => server.listen(0, '127.0.0.1', ok)); const port = server.address().port; await new Promise(ok => server.close(ok));
  const elf = path.join(fixture, 'standalone.elf');
  report.native_sha256 = digest(await fs.readFile(executable)); report.code_sha256 = digest(await fs.readFile(code));
  native = launch(executable, ['-portable', elf], { cwd: path.dirname(executable),
    env: { ...process.env, PCSX2_DEBUG_PORT: String(port), PCSX2_MCP_DATA_DIR: root } }, 'native.log');
  await new Promise((ok, no) => { native.once('spawn', ok); native.once('error', no); }); report.native_pid = native.pid;
  watchdog = setTimeout(() => { native.kill(); editor?.kill(); installer?.kill(); }, 180000);
  inspector = new DebugServerClient('127.0.0.1', port);
  for (let n = 0; ; n++) {
    assert.equal(native.exitCode, null);
    try { await inspector.connect(); await inspector.getCapabilities(); break; }
    catch (error) { inspector.disconnect(); if (n >= 199) throw error; await delay(100); }
  }
  for (let n = 0; (await inspector.getCapabilities()).elf_crc === '0x00000000'; n++) { assert.ok(n < 200); await delay(100); }
  await delay(1500); const caps = await inspector.getCapabilities();
  assert.equal(caps.process_id, native.pid); assert.equal(path.resolve(caps.data_directory), root); report.initial = caps;
  const sourceExtension = path.join(repository, 'editors/vscode'), runner = path.join(sourceExtension, 'test/run.cjs');
  let extension = sourceExtension;
  const profile = path.join(output, 'user-data'), extensions = path.join(output, 'extensions');
  await fs.mkdir(path.join(profile, 'User'), { recursive: true });
  await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'chat.disableAIFeatures': true,
    'extensions.autoUpdate': 'off', 'extensions.autoCheckUpdates': false, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
    'pcsx2.adapterPath': path.join(repository, 'pcsx2-mcp-server/dist/dap.js'), 'pcsx2.nodePath': process.execPath
  }, null, 2)+'\n');
  report.profile_settings_initial_sha256 = digest(await fs.readFile(path.join(profile, 'User/settings.json')));
  await fs.mkdir(path.join(fixture, '.vscode'));
  const projectConfiguration = { version: '0.2.0', configurations: [{ name: 'PCSX2 owned editor acceptance', type: 'pcsx2', request: 'attach',
    elf: '${workspaceFolder}/standalone.elf', expectedSha256: manifest.sha256['standalone.elf'], port, stopOnAttach: true,
    pathMappings: [{ from: '/fixture', to: '${workspaceFolder}' }] }] };
  await fs.writeFile(path.join(fixture, '.vscode/launch.json'), JSON.stringify(projectConfiguration, null, 2)+'\n');
  if (process.argv[7]) {
    const vsix = path.resolve(process.argv[7]), directory = path.dirname(code);
    const wrapper = await fs.readFile(path.join(directory, 'bin/code.cmd'), 'utf8');
    const match = /"%~dp0\.\.\\([^"]+cli\.js)"/i.exec(wrapper); assert.ok(match, 'Code CLI wrapper layout unsupported');
    const cli = path.resolve(directory, match[1]);
    assert.ok(!path.relative(directory, cli).startsWith('..')); await fs.access(cli);
    installer = launch(code, [cli, '--install-extension', vsix, '--extensions-dir', extensions, '--user-data-dir', profile, '--force'],
      { cwd: repository, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, 'editor-install.log');
    report.install_pid = installer.pid;
    report.install_exit = await new Promise((ok, no) => { installer.once('exit', (code, signal) => ok({ code, signal })); installer.once('error', no); });
    assert.equal(report.install_exit.code, 0, 'VSIX install failed');
    const candidates = (await fs.readdir(extensions)).filter(name => name.startsWith('michaaels.pcsx2-debugger-'));
    assert.equal(candidates.length, 1); extension = path.join(extensions, candidates[0]);
    for (const name of ['extension.cjs', 'configuration.cjs'])
      assert.equal(digest(await fs.readFile(path.join(extension, name))), digest(await fs.readFile(path.join(sourceExtension, name))), 'Installed extension differs: ' + name);
    report.vsix = { path: vsix, sha256: digest(await fs.readFile(vsix)), installed_directory: extension };
  }
  const testInput = { kind: 'owned_editor_acceptance', output, fixture, source: path.join(fixture, 'standalone.c'), elf,
    elf_sha256: manifest.sha256['standalone.elf'], adapter: path.join(repository, 'pcsx2-mcp-server/dist/dap.js'),
    node: process.execPath, port, native_pid: native.pid, server: path.join(repository, 'pcsx2-mcp-server'), extension,
    configurationName: 'PCSX2 owned editor acceptance' };
  const inputFile = path.join(output, 'editor-input.json'); await fs.writeFile(inputFile, JSON.stringify(testInput, null, 2)+'\n');
  report.inputs = {};
  for (const file of [path.join(extension, 'package.json'), path.join(extension, 'extension.cjs'), path.join(extension, 'configuration.cjs'), runner,
    testInput.adapter, path.join(testInput.server, 'dist/dap-session.js'), path.join(testInput.server, 'dist/dap-wire.js'), fileURLToPath(import.meta.url),
    path.join(fixture, '.vscode/launch.json')])
    report.inputs[file] = digest(await fs.readFile(file));
  const env = { ...process.env, PCSX2_EDITOR_TEST_INPUT: inputFile };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_PID']) delete env[name];
  editor = launch(code, ['--new-window', '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    '--user-data-dir=' + profile, '--extensions-dir=' + extensions, '--extensionDevelopmentPath=' + extension, '--extensionTestsPath=' + runner, fixture],
    { cwd: repository, env }, 'editor.log');
  const editorExit = new Promise((ok, no) => { editor.once('exit', (code, signal) => ok({ code, signal })); editor.once('error', no); });
  report.editor_pid = editor.pid; report.editor_exit = await editorExit;
  report.profile_settings_final_sha256 = digest(await fs.readFile(path.join(profile, 'User/settings.json')));
  assert.equal(report.editor_exit.code, 0, 'VS Code Extension Host failed; inspect editor.log');
  const accepted = JSON.parse(await fs.readFile(path.join(output, 'editor-validation.json')));
  assert.equal(accepted.passed, true, accepted.failure); assert.equal(accepted.mcp_stopped, true);
  assert.equal(accepted.checks.length, 4); assert.ok(accepted.adapter_exits?.length);
  assert.equal((await inspector.getCapabilities()).process_id, native.pid); assert.equal((await inspector.getStatus()).paused, true);
  assert.deepEqual(await inspector.listBreakpoints('ee'), []);
  assert.equal(digest(await fs.readFile(executable)), report.native_sha256); assert.equal(digest(await fs.readFile(iniPath)), report.config_sha256);
  assert.ok(!logOverflow, 'Log byte budget exceeded'); report.editor = accepted; report.passed = true;
} catch (error) { report.failure = String(error); report.stack = error.stack; process.exitCode = 1; }
finally {
  clearTimeout(watchdog); inspector?.disconnect();
  for (const child of [editor, installer, native]) if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(ok => child.once('exit', ok)); child.kill(); await Promise.race([exited, delay(5000)]);
  }
  report.native_stopped = !!native && (native.exitCode !== null || native.signalCode !== null);
  report.editor_stopped = !!editor && (editor.exitCode !== null || editor.signalCode !== null);
  if (!report.native_stopped || !report.editor_stopped) report.passed = false;
  for (const { stream } of logs) if (!stream.writableFinished) await new Promise(ok => { stream.once('finish', ok); stream.end(); });
  await fs.writeFile(path.join(output, 'validation.json'), JSON.stringify(report, null, 2)+'\n');
  if (!report.passed) process.exitCode = 1;
  console.log(report.passed ? 'PASS actual VS Code/native/MCP session; owned roots stopped' : 'FAIL ' + report.failure);
}
