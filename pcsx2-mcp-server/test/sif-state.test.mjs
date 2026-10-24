import assert from 'node:assert/strict';
import test from 'node:test';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { parseSifSnapshot, describeSifSnapshot } from '../dist/sif-state.js';
import { readSifSnapshot } from '../dist/sif-tools.js';
import { debugServer } from './fixtures.mjs';

const hex = n => '0x'+(n >>> 0).toString(16).padStart(8, '0');
const identity = { process_id: 42, session: 1, execution_epoch: 2, iop_reset_epoch: 3, iop_lifetime_epoch: 4,
  elf: 'game.elf', elf_crc: '0x12345678' };
const caps = () => ({ ...identity, ok: true, protocol_version: 2, features: ['sif_snapshot'] });
const status = (extra = {}) => ({ ok: true, data: { alive: true, paused: true, pc: '0x00100000', cycles: 5, ...extra } });
const write = (sequence = 1) => ({ sequence, session: 1, execution_epoch: 2, iop_reset_epoch: 3, iop_lifetime_epoch: 4,
  address: '0x1f8010a6', value: '0x00000001', bits: 16, word_before: '0x00000008', word_after: '0x00000008', raw_iop_pc: '0x00012340', iop_cycles: hex(1) });
function snapshot() {
  return { ...identity, ok: true, paused: true,
    sample: { ee_pc: '0x00100000', ee_cycles: hex(5), iop_pc: hex(1), iop_cycles: hex(2) },
    sbus: Object.fromEntries(['mscom','smcom','msflg','smflg','f240','ee_intc_stat','ee_intc_mask','ee_dmac_stat','iop_ireg','iop_imask','iop_ictrl'].map(k => [k, hex(0)])),
    channels: [0,1,2].map(sif => ({ sif, ee: { chcr: hex(0x101), madr: hex(0), qwc: hex(2), tadr: hex(0) },
      iop_backing: { chcr: hex(0x01000200), madr: hex(0), bcr: hex(8), tadr: hex(0) },
      backend: { ee_busy: false, ee_end: false, iop_busy: false, iop_end: false, iop_counter: 0, fifo_words: 0, fifo_read_pos: 0, fifo_write_pos: 0 } })),
    pgif: { ctrl_backing: hex(0), stat_backing: hex(0), data_fifo: { capacity: 131072, words: 0, head: 0, tail: 0 },
      command_fifo: { capacity: 8, words: 0, head: 0, tail: 0 }, linked_list_active: false, to_gpu_active: false, to_iop_active: true },
    writes: { capacity: 64, observed: 1, dropped: 0, entries: [write()] } };
}
async function setup(t, reply) {
  const mock = await debugServer(t, reply), client = new DebugServerClient('127.0.0.1', mock.port);
  await client.connect(); t.after(() => client.disconnect()); return { client, mock };
}
test('SIF report preserves a nonmatching high-halfword BCR write and does not turn it into a causal claim', () => {
  const raw = parseSifSnapshot(snapshot(), identity), r = describeSifSnapshot(raw);
  assert.equal(r.writes.entries[0].word_after, '0x00000008');
  assert.equal(r.write_comparisons[0].simple_merge_word, '0x00010008'); assert.equal(r.write_comparisons[0].matches_simple_merge, false);
  assert.equal(r.interpretation.causality, 'not_established'); assert.match(r.interpretation.writer_pc, /not_verified/);
  assert.equal(r.decoded_channels[2].ee_start_bit, true); assert.equal(r.decoded_channels[2].ee_direction_bit, 1);
  assert.equal(r.decoded_channels[2].iop_block_count_field, 0); assert.equal(r.decoded_channels[2].iop_start_bit, true);
});
test('low/high 16-bit merges and full-width writes preserve unsigned bit patterns', () => {
  for (const [address, bits, value, before, expected] of [[0x1f8010a4,16,0xffff,0x12345678,0x1234ffff],
    [0x1f8010a6,16,0xabcd,0x12345678,0xabcd5678], [0x1f8010a4,32,0xffffffff,0,0xffffffff]]) {
    const s = snapshot(); Object.assign(s.writes.entries[0], { address: hex(address), bits, value: hex(value), word_before: hex(before), word_after: hex(expected) });
    const r = describeSifSnapshot(parseSifSnapshot(s, identity)); assert.equal(r.write_comparisons[0].simple_merge_word, hex(expected));
    assert.equal(r.write_comparisons[0].matches_simple_merge, true);
  }
});
test('an invalid raw FIFO state remains available with a consistency flag instead of fabricated zeros', () => {
  const s = snapshot(); s.channels[2].backend.fifo_words = -1; s.pgif.data_fifo.words = 131073;
  const r = describeSifSnapshot(parseSifSnapshot(s, identity));
  assert.equal(r.channels[2].backend.fifo_words, -1); assert.equal(r.decoded_channels[2].backend_fifo_consistent, false);
  assert.equal(r.pgif_fifo_consistency.data, false);
});
test('bounded write history accepts empty and retained suffixes, retaining prior IOP epochs explicitly', () => {
  const s = snapshot(); s.writes = { capacity: 64, observed: 0, dropped: 0, entries: [] }; parseSifSnapshot(s, identity);
  s.writes = { capacity: 64, observed: 70, dropped: 6, entries: Array.from({ length: 64 }, (_, i) => ({ ...write(i+7), iop_lifetime_epoch: 2 })) };
  assert.equal(parseSifSnapshot(s, identity).writes.entries[0].iop_lifetime_epoch, 2);
});
test('SIF protocol refuses missing channels, forged loss counters, invalid widths/addresses and stale history identities', () => {
  for (const change of [s => s.channels.reverse(), s => s.channels.pop(), s => s.writes.dropped++, s => s.writes.entries[0].sequence++,
    s => s.writes.entries[0].execution_epoch++, s => s.writes.entries[0].iop_lifetime_epoch++, s => s.writes.entries[0].session++,
    s => s.writes.entries[0].bits = 8, s => s.writes.entries[0].value = hex(65536), s => s.writes.entries[0].address = hex(0x1f8010b0),
    s => s.writes.entries[0].address = hex(0x1f8010a5), s => delete s.sbus.ee_dmac_stat]) {
    const s = snapshot(); change(s); assert.throws(() => parseSifSnapshot(s, identity));
  }
  assert.throws(() => parseSifSnapshot(snapshot(), { ...identity, elf_crc: hex(0) }), /identity mismatch/);
});
test('snapshot sends all VM/IOP guards, only reads and preserves unsigned CPU cycles through the wire', async t => {
  const { client, mock } = await setup(t, cmd => {
    if (cmd.cmd === 'capabilities') return caps();
    if (cmd.cmd === 'status') return status();
    if (cmd.cmd === 'sif_snapshot') { assert.equal(cmd.expected_process_id, 42); assert.equal(cmd.expected_iop_lifetime_epoch, 4); return snapshot(); }
    assert.fail('Unexpected mutation: '+cmd.cmd);
  });
  const r = await readSifSnapshot(client); assert.equal(r.process_id, 42);
  assert.ok(mock.requests.every(r => ['capabilities','status','sif_snapshot'].includes(r.cmd)));
});
test('running VM, missing feature and pre-cancelled requests are refused before native snapshot', async t => {
  for (const feature of [true, false]) {
    const { client, mock } = await setup(t, cmd => cmd.cmd === 'capabilities' ? { ...caps(), features: feature ? ['sif_snapshot'] : [] } : status({ paused: false }));
    await assert.rejects(readSifSnapshot(client), /Pause|Rebuild/); assert.ok(!mock.requests.some(r => r.cmd === 'sif_snapshot'));
    const before = mock.requests.length; await assert.rejects(readSifSnapshot(client, AbortSignal.abort())); assert.equal(mock.requests.length, before);
  }
});
test('identity changes around sampling and movement of a supposedly paused CPU invalidate the snapshot', async t => {
  for (const change of ['epoch','cycles','sample']) {
    let capReads = 0, statusReads = 0;
    const { client } = await setup(t, cmd => {
      if (cmd.cmd === 'capabilities') { capReads++; return { ...caps(), execution_epoch: change === 'epoch' && capReads > 1 ? 3 : 2 }; }
      if (cmd.cmd === 'status') { statusReads++; return status({ cycles: change === 'cycles' && statusReads > 1 ? 6 : 5 }); }
      const s = snapshot(); if (change === 'sample') s.sample.ee_cycles = hex(6); return s;
    });
    await assert.rejects(readSifSnapshot(client), /changed/);
  }
});
