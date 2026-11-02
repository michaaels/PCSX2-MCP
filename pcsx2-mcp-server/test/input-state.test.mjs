import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deflateRawSync, zstdCompressSync, constants } from 'node:zlib';
import { parseInputState, inspectInputState } from '../dist/input-state.js';
import { stateEntries, stateZip } from './input-state-fixtures.mjs';

test('state inspector verifies stored/Deflate/Zstandard payload CRC while keeping native load/ELF association unknown', async () => {
  const entries = stateEntries(); entries.at(-1).method = 93;
  const result = await parseInputState(stateZip(entries));
  assert.equal(result.archive_and_payloads_verified, true); assert.equal(result.save_version, '0x9a590000');
  assert.equal(result.producer_reported, 'v2.9.147'); assert.equal(result.entries.length, 15);
  assert.equal(result.native_load, 'not_performed'); assert.equal(result.elf_association, 'not_verified'); assert.equal(result.determinism, 'not_established');
});

test('state inspector rejects missing finalization, central/local mismatch, duplicate names and missing required components', async () => {
  const bytes = stateZip(); await assert.rejects(parseInputState(bytes.subarray(0, -1)), /finalized/);
  await assert.rejects(parseInputState(Buffer.concat([bytes, Buffer.from([0])])), /finalized/);
  const changed = Buffer.from(bytes); changed.writeUInt32LE(0, 14); await assert.rejects(parseInputState(changed), /metadata mismatch/);
  const entries = stateEntries(); await assert.rejects(parseInputState(stateZip(entries.slice(0, -1))), /required entry missing/);
  await assert.rejects(parseInputState(stateZip([...entries, entries[0]])), /duplicate/);
});

test('state inspector rejects encrypted/path-traversal entries and decoded-size budget fraud', async () => {
  for (const change of [{ flags: 1 }, { name: '../outside' }, { size: 64 * 1024 ** 2 + 1 }]) {
    const entries = stateEntries(); Object.assign(entries[0], change); await assert.rejects(parseInputState(stateZip(entries)));
  }
  const entries = stateEntries(); entries.at(-1).size = 1; await assert.rejects(parseInputState(stateZip(entries)), /decoded size/);
  const expansion = stateEntries(); expansion.push({ name: 'extra-a', data: Buffer.alloc(1), method: 8, size: 64 * 1024 ** 2 },
    { name: 'extra-b', data: Buffer.alloc(1), method: 8, size: 64 * 1024 ** 2 });
  await assert.rejects(parseInputState(stateZip(expansion)), /expanded byte budget/);
});

test('state inspector rejects CRC corruption, extra compressed bytes and unsupported save version', async () => {
  let entries = stateEntries(); entries[0].crc = 0; await assert.rejects(parseInputState(stateZip(entries)), /CRC mismatch/);
  entries = stateEntries(); entries.at(-1).payload = Buffer.concat([deflateRawSync(entries.at(-1).data), Buffer.from('junk')]);
  await assert.rejects(parseInputState(stateZip(entries)), /consumed compressed input/);
  entries = stateEntries(); entries[0].data.writeUInt32LE(0x9a590001); await assert.rejects(parseInputState(stateZip(entries)), /version header/);
  entries = stateEntries(); entries.at(-1).method = 93;
  const compressed = zstdCompressSync(entries.at(-1).data, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  entries.at(-1).payload = compressed.subarray(0, -1);
  await assert.rejects(parseInputState(stateZip(entries)), /Zstandard frame checksum/);
});

test('state inspector pins file SHA and cooperatively cancels without writing the source', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'state-inspection-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); const file = path.join(directory, 'state.p2s'), bytes = stateZip(); await fs.writeFile(file, bytes);
  await assert.rejects(inspectInputState({ path: file, expected_sha256: '0'.repeat(64) }), /SHA256 mismatch/);
  const abort = new AbortController(); abort.abort(); await assert.rejects(inspectInputState({ path: file }, abort.signal));
  const inflight = new AbortController(), parsed = parseInputState(bytes, inflight.signal); setImmediate(() => inflight.abort()); await assert.rejects(parsed);
  const result = await inspectInputState({ path: file }); assert.equal(result.archive_and_payloads_verified, true);
  assert.deepEqual(await fs.readFile(file), bytes);
});
