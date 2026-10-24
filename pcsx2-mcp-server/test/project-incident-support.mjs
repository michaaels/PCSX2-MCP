// SMS-specific live evidence recipe. No guest code/register/data writes or PC assignment.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = value => '0x' + value.toString(16).padStart(8, '0');
const address = value => {
  const n = Number.parseInt(value.replace(/^0x/, ''), 16);
  assert.ok(Number.isInteger(n) && n >= 0 && n < 0x02000000, 'Incident address must be canonical EE RAM');
  return n;
};
function linkedBytes(bytes, target, length) {
  const table = bytes.readUInt32LE(28), stride = bytes.readUInt16LE(42), count = bytes.readUInt16LE(44);
  for (let i = 0; i < count; i++) {
    const p = table + stride * i;
    if (bytes.readUInt32LE(p) !== 1) continue;
    const offset = bytes.readUInt32LE(p + 4), start = bytes.readUInt32LE(p + 8), size = bytes.readUInt32LE(p + 16);
    if (target >= start && target + length <= start + size) return bytes.subarray(offset + target - start, offset + target - start + length);
  }
  assert.fail('Instruction bytes unavailable in the selected ELF');
}
function register(data, name) {
  const matches = Object.values(data).filter(cat => cat?.regs).flatMap(cat => cat.regs)
    .filter(reg => reg.name.replace(/^\$/, '').toLowerCase() === name);
  assert.equal(matches.length, 1, 'Unique register required: ' + name);
  return Number(BigInt('0x' + matches[0].value.replace(/^0x/, '')) & 0xffffffffn);
}
async function objectMetadata(elf, sha256) {
  // This GCC emits NOTYPE/size-zero statics. Require DWARF CU/location/type
  // evidence and cross-check symbol values; do not infer their extent from nm.
  const python = process.env.PCSX2_DWARF_PYTHON ?? fileURLToPath(new URL(
    process.platform === 'win32' ? '../.venv-dwarf/Scripts/python.exe' : '../.venv-dwarf/bin/python', import.meta.url));
  assert.ok(path.isAbsolute(python));
  const { stdout } = await promisify(execFile)(python,
    ['-I', fileURLToPath(new URL('./fixtures/sms-incident-objects.py', import.meta.url)), elf, sha256],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
  const result = JSON.parse(stdout);
  assert.equal(result.format_version, 1); assert.equal(result.elf_sha256, sha256); assert.equal(result.objects.length, 2);
  for (const object of result.objects) address(object.address);
  return result;
}

export async function captureUpdateIncident({ call, inspector, manifest, manifestPath, elf, output, options, waitMs, passed }) {
  const groups = new Set();
  const result = { kind: 'sms_update_path_incident', format_version: 1, event: 'update_path_failed',
    build_id: manifest.build_id, elf_sha256: manifest.elf_sha256,
    scope: 'observed_HostFs_debug_boot_only', guest_code_register_data_writes: false,
    execution_control: 'explicit_pause_source_breakpoints_and_resume', physical_validation: 'not_performed',
    e11_and_audio_causality: 'not_established' };
  try {
    for (let i = 0; (await inspector.getCapabilities()).elf_crc !== manifest.pcsx2_crc; i++) {
      assert.ok(i < 100, 'Incident ELF did not boot'); await delay(100);
    }
    await inspector.pause();
    const snapshotRoot = path.resolve(path.dirname(manifestPath), manifest.source_snapshot);
    assert.ok(snapshotRoot.startsWith(path.dirname(manifestPath) + path.sep), 'Source snapshot must stay in the artifact directory');
    const sourceName = 'src/SMS_JellyfinUpdate.c';
    const sourceFile = path.join(snapshotRoot, sourceName);
    const source = await fs.readFile(sourceFile);
    const expected = manifest.sources.filter(item => item.path === sourceName);
    assert.equal(expected.length, 1); assert.equal(hash(source), expected[0].sha256, 'Snapshot source SHA differs from manifest');
    result.source = { relative_file: sourceName, sha256: hash(source), manifest_sha256: hash(await fs.readFile(manifestPath)) };
    const lines = source.toString('utf8').split(/\r?\n/).flatMap((line, index) =>
      line.includes('if(!s_UpdateDir[0]) {SMS_JellyfinLog("update_path_failed");') ? [index + 1] : []);
    assert.equal(lines.length, 2, 'This recipe requires the two explicit updater path guards');
    const lineOptions = line => ({ elf, file: sourceFile, line, expected_sha256: manifest.elf_sha256,
      path_mappings: [{ from: manifest.source_root_at_build, to: snapshotRoot }] });
    const breakpoints = [];
    for (const line of lines) {
      const installed = await call('pcsx2_breakpoint_source', lineOptions(line));
      groups.add(installed.group_id); breakpoints.push({ line, ...installed });
    }
    await call('pcsx2_import_symbols');
    async function symbol(name, kind) {
      for (let i = 0; i < 40; i++) {
        const found = await call('pcsx2_lookup_symbols', { query: name, kind, exact: true, cpu: 'ee' });
        if (found.total_matches) {
          assert.equal(found.total_matches, 1, 'Ambiguous incident symbol: ' + name);
          assert.equal(found.symbols.length, 1); address(found.symbols[0].address);
          return found.symbols[0];
        }
        await delay(100);
      }
      assert.fail('Incident symbol unavailable: ' + name);
    }
    const elfBytes = await fs.readFile(elf); assert.equal(hash(elfBytes), manifest.elf_sha256);
    const objects = await objectMetadata(elf, manifest.elf_sha256);
    const directory = objects.objects.find(item => item.name === 's_UpdateDir'); assert.equal(directory?.size, 128);
    const disabled = objects.objects.find(item => item.name === 's_UpdatesDisabled'); assert.equal(disabled?.size, 4);
    const logger = await symbol('SMS_JellyfinLog', 'function');
    const identity = await inspector.getCapabilities();
    async function samePaused(expectedPC) {
      const caps = await inspector.getCapabilities();
      for (const key of ['process_id', 'session', 'execution_epoch', 'elf', 'elf_crc']) assert.equal(caps[key], identity[key], 'Incident identity changed');
      const status = await inspector.getStatus(); assert.ok(status.paused);
      if (expectedPC) assert.equal(status.pc, expectedPC);
      return status;
    }
    async function resumeToBreakpoint() {
      const cursor = (await inspector.readEvents(0, 200)).next_cursor;
      await inspector.resume();
      const hit = await inspector.waitEvent({ after: cursor, type: 'breakpoint', timeoutMs: Math.min(waitMs, 30000) });
      assert.ok(!hit.timed_out, 'Incident breakpoint not reached before deadline');
      return samePaused();
    }
    const guard = await resumeToBreakpoint();
    const selected = breakpoints.filter(item => item.addresses.some(pc => address(pc) === address(guard.pc)));
    assert.equal(selected.length, 1, 'Stop is not one of the owned updater guards');
    const guardSource = await call('pcsx2_source_pc');
    assert.ok(guardSource.locations.some(location => location.frames.some(frame =>
      frame.file?.endsWith('/src/SMS_JellyfinUpdate.c') && frame.line === selected[0].line)));
    const guardHex = await inspector.readMemoryStrict(guard.pc, 32);
    assert.equal(guardHex, linkedBytes(elfBytes, address(guard.pc), 32).toString('hex'), 'Loaded guard bytes differ from ELF');
    const firstByte = await inspector.readMemoryStrict(directory.address, 1);
    const disabledHex = await inspector.readMemoryStrict(disabled.address, 4);
    assert.equal(firstByte, '00', 'The observed guard does not contain an empty update path');
    assert.equal(disabledHex, '00000000', 'Updates were disabled before the path check');
    const guardRegisters = await inspector.readRegisters('ee', 0);
    const load = Buffer.from(guardHex, 'hex').readUInt32LE();
    assert.ok([0x20, 0x24].includes(load >>> 26), 'This recipe requires the guard byte load at its statement breakpoint');
    const baseRegister = guardRegisters.GPR.regs[(load >>> 21) & 31];
    const baseValue = register(guardRegisters, baseRegister.name.replace(/^\$/, '').toLowerCase());
    const effectiveAddress = (baseValue + ((load << 16) >> 16)) >>> 0;
    assert.equal(effectiveAddress, address(directory.address), 'Guard load does not address the DWARF update directory');
    const atGuard = await call('pcsx2_diagnostics_collect', options);
    const before = JSON.parse(await fs.readFile(atGuard.artifact.path));
    assert.equal(atGuard.observed_boot_ids.length, 1, 'Incident boot must be uniquely observed');
    assert.ok(!before.client_logs.some(log => log.event === result.event), 'Selected error was already emitted before this guard');
    result.boot_id = atGuard.observed_boot_ids[0];
    result.guard = { status: guard, source: guardSource, instruction_hex: guardHex,
      byte_load: { opcode: hex(load), base_register: baseRegister.name, base_value: hex(baseValue),
        effective_address: hex(effectiveAddress), matches_dwarf_object: true },
      update_directory: { ...directory, first_byte_hex: firstByte, length_proven: 'empty_C_string' },
      updates_disabled: { ...disabled, hex: disabledHex }, before_emission_capture: atGuard.artifact };
    passed('exact snapshot guard breakpoint reached; loaded instructions match ELF and the update path is empty while updates are enabled');
    for (const id of [...groups]) {
      const removed = await call('pcsx2_remove_source_breakpoints', { group_id: id }); assert.ok(removed.complete); groups.delete(id);
    }
    const logGroup = randomBytes(16).toString('hex'); groups.add(logGroup);
    await inspector.installSourceBreakpoints(logGroup, [logger.address], await inspector.getCapabilities());
    const logStop = await resumeToBreakpoint(); assert.equal(address(logStop.pc), address(logger.address));
    const registers = await inspector.readRegisters('ee', 0);
    const a0 = register(registers, 'a0'), ra = register(registers, 'ra'); address(hex(a0)); address(hex(ra));
    const stringBytes = Buffer.from(await inspector.readMemoryStrict(hex(a0), 32), 'hex');
    const end = stringBytes.indexOf(0); assert.ok(end >= 0);
    assert.equal(stringBytes.subarray(0, end).toString('ascii'), result.event, 'Logger argument differs from selected incident');
    const logHex = await inspector.readMemoryStrict(logStop.pc, 16);
    assert.equal(logHex, linkedBytes(elfBytes, address(logStop.pc), 16).toString('hex'));
    const callPC = ra - 8, callHex = await inspector.readMemoryStrict(hex(callPC), 8);
    assert.equal(callHex, linkedBytes(elfBytes, callPC, 8).toString('hex'));
    const opcode = Buffer.from(callHex, 'hex').readUInt32LE();
    const jalMatches = (opcode >>> 26) === 3 && (((callPC + 4) & 0xf0000000) | ((opcode & 0x03ffffff) << 2)) === address(logger.address);
    assert.ok(jalMatches, 'This incident recipe requires a verified direct JAL to the logger');
    const callerSource = await call('pcsx2_source_locations', { elf, expected_sha256: manifest.elf_sha256, addresses: [hex(callPC)] });
    const guardFrames = guardSource.locations.flatMap(location => location.frames);
    assert.ok(callerSource.locations.some(location => location.frames.some(frame => guardFrames.some(guardFrame =>
      frame.function === guardFrame.function && frame.file === guardFrame.file && frame.line === guardFrame.line))),
    'Caller source does not match the captured guard');
    result.logger = { status: logStop, a0: hex(a0), event_argument: result.event, ra: hex(ra), instruction_hex: logHex,
      caller: { address: hex(callPC), instruction_hex: callHex, jal_target_verified: jalMatches,
        return_address_role: jalMatches ? 'verified_JAL_to_logger' : 'not_a_verified_direct_call', source: callerSource } };
    passed('real logger entry reached with update_path_failed in a0; instruction bytes and return-address call evidence checked without assigning PC');
    const stableBefore = await samePaused(logStop.pc);
    const context = await call('pcsx2_capture_context', { cpu: 'ee', width: 320, height: 240 });
    const modules = await call('pcsx2_iop_modules');
    const stableAfter = await samePaused(logStop.pc); assert.deepEqual(stableAfter, stableBefore);
    result.cpu = { status: context.status, registers: context.read_registers,
      backtrace: context.get_backtrace, backtrace_scope: 'native_unwinder_observation_not_proven_call_chain',
      screenshot: context.screenshot, context_complete: context.complete };
    result.iop_modules = modules;
    result.iop_role = 'contemporaneous_runtime_inventory_not_identity_or_cause_of_EE_incident';
    result.identity = { process_id: identity.process_id, session: identity.session, execution_epoch: identity.execution_epoch };
    result.finding = { immediate_emission_path: 'verified_empty_update_directory_guard_in_HostFs_debug_boot',
      root_cause_scope: 'this_emission_only_not_a_general_crash_or_hardware_diagnosis' };
    assert.equal(hash(await fs.readFile(sourceFile)), result.source.sha256);
    assert.equal(hash(await fs.readFile(elf)), manifest.elf_sha256);
    assert.equal(hash(await fs.readFile(manifestPath)), result.source.manifest_sha256);
    passed('EE register/context and contemporaneous IOP inventory collected with unchanged paused PC/cycles and matching process/session/epoch');
    const removed = await inspector.removeSourceBreakpoints(logGroup); assert.ok(removed.complete); groups.delete(logGroup);
    const bytes = Buffer.from(JSON.stringify(result, null, 2)); assert.ok(bytes.length < 1024 * 1024);
    const destination = path.join(output, 'incident.json'); await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    await inspector.resume();
    return { artifact: { path: destination, sha256: hash(bytes), size_bytes: bytes.length },
      boot_id: result.boot_id, event: result.event, guard_line: selected[0].line, guard_pc: guard.pc,
      jal_target_verified: jalMatches, context_complete: context.complete };
  } finally {
    if (groups.size) {
      await inspector.pause();
      for (const id of groups) {
        const removed = await inspector.removeSourceBreakpoints(id); assert.ok(removed.complete, 'Owned incident breakpoint cleanup incomplete');
      }
    }
  }
}
