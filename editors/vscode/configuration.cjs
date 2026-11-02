// SPDX-License-Identifier: GPL-3.0-only
const fs = require('node:fs');
const path = require('node:path');
const envKeys = new Set(['PCSX2_DWARF_PYTHON', 'PCSX2_ADDR2LINE_BACKEND', 'PCSX2_ADDR2LINE', 'PCSX2_ADDR2LINE_WSL_DISTRO']);
const clean = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f]/.test(value);
function localFile(value, label) {
  if (!clean(value) || !path.isAbsolute(value) || !fs.statSync(value).isFile()) throw new Error(label + ' must name an existing absolute local file');
  return fs.realpathSync(value);
}
function validateConfiguration(input, defaults = {}) {
  if (input.type !== 'pcsx2' || input.request !== 'attach') throw new Error('PCSX2 supports an attach configuration only');
  const config = { ...input, port: input.port ?? 21512, stopOnAttach: input.stopOnAttach ?? true,
    adapterPath: input.adapterPath || defaults.adapterPath, nodePath: input.nodePath || defaults.nodePath || 'node', pathMappings: input.pathMappings ?? [], env: input.env ?? {} };
  config.adapterPath = localFile(config.adapterPath, 'adapterPath');
  if (!config.adapterPath.endsWith('.js')) throw new Error('adapterPath must select the built dist/dap.js JavaScript entry');
  config.elf = localFile(config.elf, 'elf');
  if (config.nodePath !== 'node') config.nodePath = localFile(config.nodePath, 'nodePath');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('port must be an integer from 1 through 65535');
  if (typeof config.stopOnAttach !== 'boolean') throw new Error('stopOnAttach must be boolean');
  if (config.host !== undefined && config.host !== '127.0.0.1') throw new Error('Only loopback DebugServer is supported');
  if (config.expectedSha256 !== undefined && !/^[\da-fA-F]{64}$/.test(config.expectedSha256)) throw new Error('expectedSha256 must have 64 hexadecimal characters');
  if (!Array.isArray(config.pathMappings) || config.pathMappings.length > 16) throw new Error('At most sixteen pathMappings are supported');
  for (const mapping of config.pathMappings) {
    if (!mapping || Object.keys(mapping).some(k => !['from', 'to'].includes(k)) || ![mapping.from, mapping.to].every(v => clean(v) && (v.startsWith('/') || /^[a-z]:[\\/]/i.test(v))))
      throw new Error('Each source mapping needs absolute from/to prefixes');
  }
  if (!config.env || typeof config.env !== 'object' || Array.isArray(config.env)) throw new Error('env must be a DWARF backend configuration object');
  for (const [key, value] of Object.entries(config.env)) if (!envKeys.has(key) || !clean(value)) throw new Error('Unsupported or invalid backend environment option');
  if (config.env.PCSX2_ADDR2LINE_BACKEND !== undefined && !['auto', 'native', 'wsl'].includes(config.env.PCSX2_ADDR2LINE_BACKEND)) throw new Error('Invalid addr2line backend');
  return config;
}
module.exports = { validateConfiguration };
