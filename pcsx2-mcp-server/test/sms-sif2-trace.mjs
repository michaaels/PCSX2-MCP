// Optional incident trace, separate from the playback measurement interval.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export async function traceSif2({ call, inspector, manifest, snapshot, elf, run, groups, checkIdentity, playerState, captureSif }) {
  const name = 'src/SMS_SPU.c', sourcePath = path.join(snapshot, name), source = await fs.readFile(sourcePath);
  const sha = createHash('sha256').update(source).digest('hex');
  assert.equal(sha, manifest.sources.find(s => s.path === name)?.sha256);
  const lines = source.toString('utf8').split(/\r?\n/), start = lines.findIndex(s => s.startsWith('static void SPU_PlayPCM ( void* apData )'));
  const end = lines.findIndex((s, i) => i > start && s.includes('end SPU_PlayPCM'));
  assert.ok(start >= 0 && end > start);
  const waits = lines.flatMap((s, i) => i > start && i < end && s.trim() === 'WaitSema ( s_SemaPCM );' ? [i + 1] : []);
  assert.equal(waits.length, 2);
  const condition = lines.flatMap((s, i) => i > start && i < end && s.trim() === 'if ( lSize ) {' ? [i + 1] : []);
  assert.equal(condition.length, 1);
  const python = process.env.PCSX2_DWARF_PYTHON ?? fileURLToPath(new URL(
    process.platform === 'win32' ? '../.venv-dwarf/Scripts/python.exe' : '../.venv-dwarf/bin/python', import.meta.url));
  assert.ok(path.isAbsolute(python));
  const metadata = JSON.parse((await promisify(execFile)(python,
    ['-I', fileURLToPath(new URL('./fixtures/sms-sif2-objects.py', import.meta.url)), elf, manifest.elf_sha256],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 1048576, windowsHide: true })).stdout);
  assert.equal(metadata.elf_sha256, manifest.elf_sha256); assert.equal(metadata.objects.length, 1);
  run.sif2_metadata = metadata;
  run.sif2_trace = [];
  for (const [label, line] of [['before_header_ack_wait', waits[0]], ['after_header_ack_following_marker', condition[0]], ['before_payload_ack_wait', waits[1]]]) {
    const point = await call('pcsx2_breakpoint_source', { elf, file: sourcePath, line, expected_sha256: manifest.elf_sha256,
      path_mappings: [{ from: manifest.source_root_at_build, to: snapshot }] }); groups.add(point.group_id);
    if (label === 'after_header_ack_following_marker') {
      const previous = run.sif2_trace[0], returnPc = Number(previous.wait_call.return_pc);
      // The supported source marker is four bytes after return. Preserve this
      // gap explicitly: it is not an observation at the exact return PC.
      assert.ok(point.addresses.some(pc => Number(pc) === returnPc + 4));
      assert.equal(Buffer.from(previous.instruction_hex, 'hex').readUInt32LE(12) >>> 26, 15, 'Expected one intervening LUI');
    }
    const step = { label, source: name, source_sha256: sha, line, breakpoint: point, wait_timeout_ms: 10000 }; run.sif2_trace.push(step);
    const after = (await inspector.readEvents(0, 200)).next_cursor; await inspector.resume();
    const hit = await inspector.waitEvent({ after, type: 'breakpoint', timeoutMs: 10000 }); step.reached = !hit.timed_out;
    assert.ok(step.reached, 'SIF2 incident trace did not reach '+label);
    await checkIdentity(); step.status = await inspector.getStatus(); assert.ok(step.status.paused);
    assert.ok(point.addresses.some(pc => Number(pc) === Number(step.status.pc)));
    step.player_state = await playerState(); step.registers = await inspector.readRegisters('ee', 0);
    if (captureSif) step.sif = await captureSif();
    step.instruction_hex = await inspector.readMemoryStrict(step.status.pc, 32);
    if (label === 'before_header_ack_wait') {
      const bytes = Buffer.from(step.instruction_hex, 'hex'), pc = Number(step.status.pc);
      const load = bytes.readUInt32LE(0), jal = bytes.readUInt32LE(4);
      assert.equal(load >>> 26, 35); assert.equal((load >>> 21) & 31, 28); assert.equal((load >>> 16) & 31, 4);
      assert.equal(jal >>> 26, 3);
      const target = (((pc + 8) & 0xf0000000) | ((jal & 0x03ffffff) << 2)) >>> 0;
      assert.equal(target, Number(metadata.wait_sema_address), 'Observed call is not the retained ELF WaitSema');
      const registers = Object.values(step.registers).filter(v => v?.regs).flatMap(v => v.regs);
      const gp = registers.filter(r => r.name.replace(/^\$/, '').toLowerCase() === 'gp'); assert.equal(gp.length, 1);
      const gpValue = Number(BigInt('0x'+gp[0].value.replace(/^0x/, '')) & 0xffffffffn);
      const immediate = (load & 0xffff) << 16 >> 16, effective = (gpValue + immediate) >>> 0;
      assert.equal(effective, Number(metadata.objects[0].address));
      const value = await inspector.readMemoryStrict(metadata.objects[0].address, 4);
      step.wait_call = { jal_pc: '0x'+(pc+4).toString(16).padStart(8, '0'), target: metadata.wait_sema_address,
        return_pc: '0x'+(pc+12).toString(16).padStart(8, '0'), semaphore_address: metadata.objects[0].address,
        semaphore_hex: value, semaphore_id: Buffer.from(value, 'hex').readInt32LE(), gp: gpValue,
        verified: 'runtime_LW_gp_effective_address_and_JAL_match_DWARF_static_and_ELF_symbol' };
    }
    assert.ok((await call('pcsx2_remove_source_breakpoints', { group_id: point.group_id })).complete); groups.delete(point.group_id);
  }
}
