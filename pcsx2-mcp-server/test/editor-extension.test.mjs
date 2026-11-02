import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { validateConfiguration } = require('../../editors/vscode/configuration.cjs');

async function inputs(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'editor-config-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const adapterPath = path.join(directory, 'dap.js'), elf = path.join(directory, 'debug.elf');
  await fs.writeFile(adapterPath, '// configuration fixture only'); await fs.writeFile(elf, 'configuration fixture only');
  return { type: 'pcsx2', request: 'attach', adapterPath, elf };
}

test('editor configuration resolves explicit files/defaults and retains source mappings', async t => {
  const input = await inputs(t), mappings = [{ from: '/build', to: path.dirname(input.elf) }];
  const result = validateConfiguration({ ...input, adapterPath: undefined, pathMappings: mappings }, { adapterPath: input.adapterPath });
  assert.equal(result.port, 21512); assert.equal(result.nodePath, 'node'); assert.equal(result.stopOnAttach, true);
  assert.equal(result.adapterPath, input.adapterPath); assert.deepEqual(result.pathMappings, mappings);
});

test('editor rejects unsupported execution, invalid files/ports/maps/hash and arbitrary environment', async t => {
  const input = await inputs(t);
  for (const extra of [{ request: 'launch' }, { port: 0 }, { host: '192.0.2.1' }, { elf: 'relative.elf' },
    { adapterPath: 'node --eval code' }, { nodePath: 'node --eval code' }, { stopOnAttach: 'yes' },
    { expectedSha256: 'bad' }, { pathMappings: [{ from: 'relative', to: '/local' }] },
    { env: { NODE_OPTIONS: '--eval code' } }, { env: { PCSX2_ADDR2LINE_BACKEND: 'shell' } }])
    assert.throws(() => validateConfiguration({ ...input, ...extra }));
});

test('editor provider refuses untrusted workspaces and factory uses argument arrays with backend-only env', async t => {
  const input = await inputs(t), registration = {}, disposables = [];
  const vscode = { workspace: { isTrusted: false, getConfiguration: () => ({ get: key => key === 'nodePath' ? 'node' : input.adapterPath }) },
    debug: { registerDebugConfigurationProvider: (type, provider) => { registration.provider = provider; return {}; },
      registerDebugAdapterDescriptorFactory: (type, factory) => { registration.factory = factory; return {}; } },
    DebugAdapterExecutable: class { constructor(command, args, options) { Object.assign(this, { command, args, options }); } } };
  const module = { exports: {} }, source = await fs.readFile(fileURLToPath(new URL('../../editors/vscode/extension.cjs', import.meta.url)), 'utf8');
  vm.runInNewContext(source, { module, require: name => name === 'vscode' ? vscode : { validateConfiguration } });
  module.exports.activate({ subscriptions: disposables }); assert.equal(disposables.length, 2);
  assert.throws(() => registration.provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, input), /trusted/);
  vscode.workspace.isTrusted = true;
  const config = registration.provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, input);
  const descriptor = registration.factory.createDebugAdapterDescriptor({ configuration: config });
  assert.equal(descriptor.command, 'node'); assert.equal(descriptor.args.length, 1); assert.equal(descriptor.args[0], input.adapterPath);
  assert.equal(Object.keys(descriptor.options.env).length, 0);
});

test('editor contribution keeps workspace placeholders literal and advertises only attach', async () => {
  const manifest = JSON.parse(await fs.readFile(fileURLToPath(new URL('../../editors/vscode/package.json', import.meta.url)), 'utf8'));
  const debuggerInfo = manifest.contributes.debuggers[0];
  assert.equal(debuggerInfo.type, 'pcsx2'); assert.deepEqual(Object.keys(debuggerInfo.configurationAttributes), ['attach']);
  assert.equal(debuggerInfo.initialConfigurations[0].elf, '${workspaceFolder}/build/game-debug.elf');
  assert.equal(debuggerInfo.configurationSnippets[0].body.elf, '^"\\${workspaceFolder}/build/game-debug.elf"');
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
});
