// SPDX-License-Identifier: GPL-3.0-only
const vscode = require('vscode');
const { validateConfiguration } = require('./configuration.cjs');

function activate(context) {
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('pcsx2', {
    resolveDebugConfigurationWithSubstitutedVariables(folder, config) {
      if (!vscode.workspace.isTrusted) throw new Error('PCSX2 debugging needs a trusted workspace');
      const settings = vscode.workspace.getConfiguration('pcsx2', folder?.uri);
      return validateConfiguration(config, { adapterPath: settings.get('adapterPath'), nodePath: settings.get('nodePath') });
    }
  }));
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('pcsx2', {
    createDebugAdapterDescriptor(session) {
      const config = validateConfiguration(session.configuration);
      return new vscode.DebugAdapterExecutable(config.nodePath, [config.adapterPath], { env: config.env });
    }
  }));
}
module.exports = { activate };
