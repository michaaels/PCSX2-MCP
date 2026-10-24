// Real retained DWARF fixture checks, separate from the BIOS-free Node suite.
// node test/sms-playback-metadata.mjs <SMS-debug-ELF> <SHA256>
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
assert.equal(process.argv.length, 4);
const [elf, sha] = process.argv.slice(2); assert.ok(path.isAbsolute(elf)); assert.match(sha, /^[a-f0-9]{64}$/);
const python = process.env.PCSX2_DWARF_PYTHON ?? fileURLToPath(new URL(
  process.platform === 'win32' ? '../.venv-dwarf/Scripts/python.exe' : '../.venv-dwarf/bin/python', import.meta.url));
async function inspect(helper, digest = sha) {
  const { stdout } = await promisify(execFile)(python, ['-I', fileURLToPath(new URL('./fixtures/'+helper, import.meta.url)), elf, digest],
    { windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 1048576 });
  return JSON.parse(stdout);
}
const old = await inspect('sms-incident-objects.py'); assert.equal(old.objects.length, 2);
assert.deepEqual(old.objects.map(o => o.name).sort(), ['s_UpdateDir', 's_UpdatesDisabled']);
console.log('PASS updater default DWARF profile retains its two known objects');
const playback = await inspect('sms-playback-objects.py'); assert.equal(playback.objects.length, 9);
const ids = playback.objects.find(o => o.name === 's_ID'); assert.equal(ids.size, 2112);
assert.equal(ids.source_file.replaceAll('\\', '/').split('/').at(-1), 'SMS_Jellyfin.c');
assert.equal(new Set(playback.objects.map(o => o.address)).size, 9);
assert.ok(playback.objects.every(o => o.origin.includes('DWARF') && o.location_hex.startsWith('03')));
console.log('PASS nine menu statics include the actual 64 by 33 byte ID array with direct DWARF/symtab agreement');
const player = await inspect('sms-player-state.py'); assert.equal(player.fields.length, 12);
assert.ok(player.fields.every(f => f.offset >= 0 && f.offset + f.size <= player.size));
assert.equal(new Set(player.fields.map(f => f.name)).size, 12);
assert.ok(player.fields.filter(f => ['m_AudioTime','m_VideoTime'].includes(f.name)).every(f => f.size === 8 && f.signed));
console.log('PASS selected player member extents and signed 64-bit clocks are verified by real retained DWARF');
const sif2 = await inspect('sms-sif2-objects.py'); assert.equal(sif2.objects.length, 1);
assert.equal(sif2.objects[0].name, 's_SemaPCM'); assert.equal(sif2.objects[0].size, 4);
assert.match(sif2.wait_sema_address, /^0x[0-9a-f]{8}$/);
console.log('PASS SIF2 semaphore location and WaitSema symbol are verified in the retained ELF');
for (const helper of ['sms-incident-objects.py', 'sms-playback-objects.py', 'sms-player-state.py', 'sms-sif2-objects.py']) {
  await assert.rejects(inspect(helper, '0'.repeat(64)));
  console.log('PASS stale ELF SHA refuses '+helper);
}
