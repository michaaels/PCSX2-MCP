// SPDX-License-Identifier: GPL-3.0-only
// Loaded by the actual VS Code Extension Development Host (--extensionTestsPath).
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const delay = ms => new Promise(ok => setTimeout(ok, ms));
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
async function waitFor(predicate, description) {
  for (let n = 0; n < 1500; n++) { const result = await predicate(); if (result) return result; await delay(20); }
  throw new Error('Timed out: ' + description);
}
async function run() {
  const input = JSON.parse(await fs.readFile(process.env.PCSX2_EDITOR_TEST_INPUT, 'utf8'));
  assert.equal(input.kind, 'owned_editor_acceptance');
  const report = { kind: 'actual_VSCode_DAP_MCP_acceptance', passed: false, checks: [], vscode_version: vscode.version,
    SMS_or_Jellyfin_involved: false, physical_validation: 'not_performed' };
  const messages = [], disposables = [], adapterExits = [];
  let mcp, transport, inspector, session, breakpoint;
  const passed = text => { report.checks.push(text); console.log('PASS ' + text); };
  try {
    const extension = vscode.extensions.getExtension('michaaels.pcsx2-debugger'); assert.ok(extension);
    if (input.extension) assert.equal(pathKey(extension.extensionPath), pathKey(input.extension));
    await extension.activate(); assert.equal(extension.isActive, true); assert.equal(vscode.workspace.isTrusted, true);
    const folder = vscode.workspace.workspaceFolders?.[0]; assert.equal(pathKey(folder.uri.fsPath), pathKey(input.fixture));
    disposables.push(vscode.debug.registerDebugAdapterTrackerFactory('pcsx2', {
      createDebugAdapterTracker(tracked) {
        return { onDidSendMessage(message) { if (messages.length >= 2048) throw new Error('Editor transcript budget exceeded'); messages.push({ direction: 'adapter_to_editor', session: tracked.id, message }); },
          onWillReceiveMessage(message) { if (messages.length >= 2048) throw new Error('Editor transcript budget exceeded'); messages.push({ direction: 'editor_to_adapter', session: tracked.id, message }); },
          onExit(code, signal) { adapterExits.push({ session: tracked.id, code, signal }); } };
      }
    }));
    breakpoint = new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(input.source), new vscode.Position(6, 0)));
    vscode.debug.addBreakpoints([breakpoint]);
    const started = await vscode.debug.startDebugging(folder, input.configurationName);
    assert.equal(started, true);
    session = await waitFor(() => vscode.debug.activeDebugSession, 'active editor debug session');
    assert.equal(session.type, 'pcsx2'); report.session_id = session.id;
    assert.equal(pathKey(session.configuration.elf), pathKey(input.elf));
    assert.equal(pathKey(session.configuration.pathMappings[0].to), pathKey(input.fixture));
    assert.equal(pathKey(session.configuration.adapterPath), pathKey(input.adapter));
    report.project_configuration = { name: session.configuration.name, elf: session.configuration.elf, adapterPath: session.configuration.adapterPath,
      port: session.configuration.port, pathMappings: session.configuration.pathMappings };
    const stops = () => messages.filter(x => x.direction === 'adapter_to_editor' && x.message.event === 'stopped');
    await waitFor(() => stops().find(x => x.message.body.reason === 'entry'), 'initial editor stop');
    await waitFor(() => messages.find(x => x.direction === 'adapter_to_editor' && x.message.command === 'setBreakpoints' && x.message.success && x.message.body.breakpoints.some(bp => bp.verified && bp.line === 7)), 'verified editor source breakpoint');
    const stopCursor = stops().length;
    await vscode.commands.executeCommand('workbench.action.debug.continue');
    await waitFor(() => stops().slice(stopCursor).find(x => x.message.body.reason === 'breakpoint'), 'breakpoint after actual editor Continue command');
    const frames = await session.customRequest('stackTrace', { threadId: 1, startFrame: 0, levels: 1 }), frame = frames.stackFrames[0];
    assert.equal(frame.line, 7); assert.equal(pathKey(frame.source.path), pathKey(input.source));
    // Let VS Code navigate its real source editor; do not emulate navigation in the test.
    const editor = await waitFor(() => vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'file' && pathKey(e.document.uri.fsPath) === pathKey(input.source) && e.selection.active.line === 6), 'actual source editor selection on breakpoint');
    const expectedSource = await fs.readFile(input.source, 'utf8'); assert.equal(editor.document.getText(), expectedSource);
    assert.ok(editor.document.lineAt(6).text.includes('MCP_TICK'));
    report.editor = { uri: editor.document.uri.toString(), language: editor.document.languageId, selection_line: editor.selection.active.line,
      source_sha256: createHash('sha256').update(editor.document.getText()).digest('hex') };
    report.frame = frame;
    passed('Actual VS Code extension/session/Continue command verified and hit the mapped C breakpoint, with matching source open at line 7');

    const requireMcp = createRequire(path.join(input.server, 'package.json'));
    const { Client } = requireMcp('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = requireMcp('@modelcontextprotocol/sdk/client/stdio.js');
    const { DebugServerClient } = await import(pathToFileURL(path.join(input.server, 'dist/debug-server-client.js')).href);
    inspector = new DebugServerClient('127.0.0.1', input.port); await inspector.connect();
    const caps = await inspector.getCapabilities(); assert.equal(caps.process_id, input.native_pid); report.native_identity = caps;
    mcp = new Client({ name: 'vscode-crosscheck', version: '1.0' });
    transport = new StdioClientTransport({ command: input.node, args: [path.join(input.server, 'dist/index.js')],
      env: { ...process.env, PCSX2_DEBUG_PORT: String(input.port) }, stderr: 'pipe' });
    transport.stderr?.resume(); await mcp.connect(transport); report.mcp_pid = transport.pid;
    assert.ok(!(await mcp.callTool({ name: 'pcsx2_connect', arguments: { mode: 'debug', debug_port: input.port } })).isError);
    async function tool(name, args = {}) {
      const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 30000 }); assert.ok(!r.isError, JSON.stringify(r.content)); return JSON.parse(r.content[0].text);
    }
    const status = await inspector.getStatus(), mcpSource = await tool('pcsx2_source_pc'), mcpVars = await tool('pcsx2_variables', { frame_index: 0 });
    assert.equal(frame.instructionPointerReference, status.pc); assert.equal(status.paused, true); assert.equal(mcpSource.locations[0].frames[0].line, frame.line);
    const scopes = (await session.customRequest('scopes', { frameId: frame.id })).scopes;
    const registers = (await session.customRequest('variables', { variablesReference: scopes[0].variablesReference })).variables;
    const locals = (await session.customRequest('variables', { variablesReference: scopes[1].variablesReference })).variables;
    assert.deepEqual(registers.slice(0, 32).map(r => r.value), mcpVars.snapshot.gpr);
    const argument = locals.find(v => v.name === 'increment'), fromMcp = mcpVars.variables.find(v => v.name === 'increment');
    assert.equal(argument.value, '1'); assert.equal(argument.value, fromMcp.value);
    const memory = await session.customRequest('readMemory', { memoryReference: argument.memoryReference, count: 4 });
    assert.equal(Buffer.from(memory.data, 'base64').toString('hex'), await inspector.readMemoryStrict(argument.memoryReference, 4));
    assert.equal(Buffer.from(memory.data, 'base64').readUInt32LE(), 1);
    assert.deepEqual(await inspector.getStatus(), status);
    report.mcp_source = mcpSource; report.mcp_variables = mcpVars; report.editor_registers = registers; report.editor_locals = locals; report.editor_memory = memory;
    passed('Editor-session source, all EE GPRs, frame-0 argument and guarded RAM match independent MCP/native inspection at the identical pause');

    vscode.debug.removeBreakpoints([breakpoint]); breakpoint = undefined;
    await waitFor(async () => (await inspector.listBreakpoints('ee')).length === 0, 'editor breakpoint removal');
    const beforeStep = stops().length;
    await vscode.commands.executeCommand('workbench.action.debug.stepOver');
    await waitFor(() => stops().slice(beforeStep).find(x => x.message.body.reason === 'step'), 'actual editor source step-over');
    const steppedFrame = (await session.customRequest('stackTrace', { threadId: 1, levels: 1 })).stackFrames[0];
    const steppedMcp = await tool('pcsx2_source_pc'); assert.equal(steppedFrame.instructionPointerReference, steppedMcp.locations[0].address);
    assert.equal(steppedFrame.line, steppedMcp.locations[0].frames[0].line); assert.notEqual(steppedFrame.line, frame.line);
    await assert.rejects(session.customRequest('scopes', { frameId: frame.id }));
    report.stepped_frame = steppedFrame; report.stepped_mcp = steppedMcp;
    passed('Actual editor Step Over reaches another source line matching MCP, and previous frame references refuse reuse');

    const beforeDetach = await inspector.getStatus(), ended = new Promise(ok => {
      const subscription = vscode.debug.onDidTerminateDebugSession(s => { if (s.id === session.id) { subscription.dispose(); ok(); } }); disposables.push(subscription);
    });
    await vscode.debug.stopDebugging(session); await Promise.race([ended, delay(10000).then(() => { throw new Error('Editor detach timeout'); })]);
    await waitFor(() => adapterExits.some(e => e.session === session.id), 'editor-owned adapter process exit');
    report.adapter_exits = adapterExits;
    assert.equal(adapterExits.find(e => e.session === session.id).code, 0, 'Editor adapter did not exit cleanly');
    assert.equal((await inspector.getCapabilities()).process_id, input.native_pid); assert.deepEqual(await inspector.getStatus(), beforeDetach);
    assert.deepEqual(await inspector.listBreakpoints('ee'), []); session = undefined;
    passed('Editor detach closes the debug session while retaining the same attached native process/paused state and no owned points');
    report.passed = true;
  } catch (error) { report.failure = String(error); report.stack = error.stack; throw error; }
  finally {
    if (breakpoint) vscode.debug.removeBreakpoints([breakpoint]);
    if (session) await vscode.debug.stopDebugging(session).catch(() => {});
    inspector?.disconnect();
    try { await mcp?.close(); report.mcp_stopped = !transport || transport.pid === null; } catch (error) { report.cleanup_error = String(error); report.passed = false; }
    for (const item of disposables) item.dispose();
    await fs.writeFile(path.join(input.output, 'editor-transcript.json'), JSON.stringify(messages, null, 2)+'\n');
    await fs.writeFile(path.join(input.output, 'editor-validation.json'), JSON.stringify(report, null, 2)+'\n');
  }
}
module.exports = { run };
