import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { compareVisualPixels, compareVisualFiles, decodeVisualPng, visualHash } from '../dist/visual-comparison.js';
import { inspectSourceElf } from '../dist/source-debug.js';
import { ScenarioRunner } from '../dist/scenario.js';
import { workflowFixture, capabilities } from './workflow-fixtures.mjs';

function png(width = 4, height = 4, edit = () => {}, colorType = 6) {
  const image = new PNG({ width, height });
  for (let i = 0; i < image.data.length; i += 4) image.data.set([80, 90, 100, 255], i);
  edit(image.data);
  return PNG.sync.write(image, { colorType, bitDepth: 8, inputColorType: 6 });
}
function chunk(type, bytes) {
  const payload = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff;
  for (const byte of payload) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); payload.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
}
function rawPng(width, height, rows, { depth = 8, color = 6, interlace = 0, extra = [] } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = depth; header[9] = color; header[12] = interlace;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), ...extra,
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
async function directoryFor(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pcsx2-visual-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory;
}
async function files(t, a = png(), b = a) {
  const directory = await directoryFor(t), baseline_path = path.join(directory, 'reference.png'), current_path = path.join(directory, 'actual.png');
  await fs.writeFile(baseline_path, a); await fs.writeFile(current_path, b);
  return { baseline_path, baseline_sha256: visualHash(a), current_path, current_sha256: visualHash(b), output_directory: path.join(directory, 'out') };
}

test('visual comparison decodes equivalent RGB and RGBA encodings instead of comparing PNG bytes', async () => {
  const a = png(), b = png(4, 4, () => {}, 2);
  assert.notEqual(visualHash(a), visualHash(b));
  const result = await compareVisualPixels(a, b);
  assert.ok(result.passed); assert.equal(result.regions[0].max_channel_delta, 0);
  assert.equal(result.coverage.compared_pixels, 16);
});

test('channel tolerance is inclusive and still reports raw differences and exact error metrics', async () => {
  const a = png(2, 2), b = png(2, 2, bytes => { bytes[0] += 6; });
  const failed = await compareVisualPixels(a, b, { channel_tolerance: 5 });
  assert.equal(failed.passed, false); assert.equal(failed.regions[0].pixels_over_tolerance, 1);
  assert.equal(failed.regions[0].mean_absolute_channel_delta, .5);
  const passed = await compareVisualPixels(a, b, { channel_tolerance: 6 });
  assert.ok(passed.passed); assert.equal(passed.regions[0].pixels_over_tolerance, 0);
  assert.equal(passed.regions[0].pixels_with_any_difference, 1);
});

test('pixel mismatch budgets use an inclusive per-region fraction with no rounding of verdicts', async () => {
  const a = png(2, 2), b = png(2, 2, bytes => { bytes[0] = 255; });
  assert.ok((await compareVisualPixels(a, b, { max_changed_fraction: .25 })).passed);
  assert.equal((await compareVisualPixels(a, b, { max_changed_fraction: .2499 })).passed, false);
});

test('named regions have independent overrides and report excluded screen coverage', async () => {
  const a = png(), b = png(4, 4, bytes => { bytes[0] += 5; bytes[8] += 5; bytes[60] = 0; });
  const result = await compareVisualPixels(a, b, { regions: [
    { name: 'lenient', x: 0, y: 0, width: 2, height: 1, channel_tolerance: 5 },
    { name: 'strict', x: 2, y: 0, width: 2, height: 1 },
  ] });
  assert.deepEqual(result.regions.map(r => r.passed), [true, false]);
  assert.equal(result.coverage.outside_region_pixels, 12);
});

test('overlapping ignored rectangles form a union and remove pixels from the denominator', async () => {
  const a = png(3, 1), b = png(3, 1, bytes => { bytes[0] = bytes[4] = bytes[8] = 255; });
  const result = await compareVisualPixels(a, b, { ignore_regions: [
    { x: 0, y: 0, width: 2, height: 1 }, { x: 1, y: 0, width: 1, height: 1 },
  ] });
  assert.equal(result.coverage.ignored_pixels, 2); assert.equal(result.regions[0].compared_pixels, 1);
  assert.equal(result.regions[0].changed_fraction, 1);
});

test('invalid, duplicate, overlapping and fully masked include regions refuse rather than clip or silently pass', async () => {
  const a = png(), r = { name: 'one', x: 0, y: 0, width: 2, height: 2 };
  for (const policy of [
    { regions: [{ ...r, x: 3 }] }, { regions: [r, { ...r, x: 2 }] },
    { regions: [r, { ...r, name: 'two', x: 1 }] },
    { regions: [r], ignore_regions: [{ x: 0, y: 0, width: 2, height: 2 }] },
    { channel_tolerance: 256 }, { max_changed_fraction: 1.01 }, { regions: [{ ...r, width: 0 }] },
  ]) await assert.rejects(compareVisualPixels(a, a, policy));
});

test('dimensions mismatch is an explicit failed comparison with both input artifacts and no fabricated diff', async t => {
  const options = await files(t, png(3, 2), png(2, 3));
  const result = await compareVisualFiles(options);
  assert.equal(result.reason, 'dimensions_mismatch'); assert.equal(result.passed, false);
  assert.equal(result.artifacts.diff, null); assert.deepEqual(result.regions, []);
  assert.ok((await fs.stat(result.artifacts.current.path)).isFile());
  assert.equal(JSON.parse(await fs.readFile(result.artifacts.report.path)).passed, false);
});

test('opaque, noninterlaced eight-bit RGB/RGBA and dimensional bounds are enforced before unsafe decoding', () => {
  const rows = Buffer.from([0, 80, 90, 100, 255]);
  for (const input of [png(1, 1, data => { data[3] = 0; }), rawPng(1, 1, rows, { interlace: 1 }),
    rawPng(1, 1, rows, { depth: 16 }), rawPng(1, 1, rows, { color: 3 }), png(1281, 1)])
    assert.throws(() => decodeVisualPng(input));
});

test('CRC, truncated chunks, APNG, unknown critical chunks and trailing data fail closed', () => {
  const original = png(1, 1), corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 1;
  const rows = Buffer.from([0, 80, 90, 100, 255]);
  for (const input of [corrupt, original.subarray(0, -2), Buffer.concat([original, Buffer.from('extra')]),
    rawPng(1, 1, rows, { extra: [chunk('acTL', Buffer.alloc(8))] }),
    rawPng(1, 1, rows, { extra: [chunk('ABCD', Buffer.alloc(0))] })]) assert.throws(() => decodeVisualPng(input));
});

test('surplus decompressed scanlines are rejected even when PNG dimensions and CRC are valid', () => {
  assert.throws(() => decodeVisualPng(rawPng(1, 1, Buffer.from([0, 80, 90, 100, 255, 0]))), /scanlines/);
  assert.throws(() => decodeVisualPng(rawPng(1, 1, Buffer.alloc(1024 * 1024))), /scanlines/);
});

test('hash-pinned file reads reject replaced/corrupt inputs before creating an artifact folder', async t => {
  const options = await files(t);
  await fs.writeFile(options.baseline_path, png(4, 4, bytes => { bytes[0]++; }));
  await assert.rejects(compareVisualFiles(options), /SHA256/);
  await assert.rejects(fs.stat(options.output_directory), /ENOENT/);
  await assert.rejects(compareVisualFiles({ ...options, baseline_path: 'relative.png' }));
});

test('successful and failed comparisons preserve exact inputs, unique reports, diff colors and policy hash', async t => {
  const a = png(2, 1), b = png(2, 1, bytes => { bytes[0] = 200; bytes[4]++; });
  const options = await files(t, a, b);
  const result = await compareVisualFiles({ ...options, policy: { channel_tolerance: 1 } });
  assert.equal(result.passed, false); assert.match(result.policy_sha256, /^[a-f\d]{64}$/);
  assert.deepEqual(await fs.readFile(result.artifacts.baseline.path), a);
  assert.deepEqual(await fs.readFile(result.artifacts.current.path), b);
  const diff = decodeVisualPng(await fs.readFile(result.artifacts.diff.path));
  assert.deepEqual([...diff.data.subarray(0, 8)], [255, 0, 0, 255, 255, 200, 0, 255]);
  const second = await compareVisualFiles({ ...options, policy: { channel_tolerance: 255 } });
  assert.ok(second.passed); assert.notEqual(result.artifacts.report.path, second.artifacts.report.path);
  assert.equal(visualHash(await fs.readFile(options.baseline_path)), options.baseline_sha256);
});

test('oversized file and untrusted malformed content errors do not echo PNG data', async t => {
  const options = await files(t); const secret = 'PRIVATE_TOKEN_DO_NOT_ECHO';
  const malformed = Buffer.from(secret.repeat(4)); await fs.writeFile(options.current_path, malformed);
  try { await compareVisualFiles({ ...options, current_sha256: visualHash(malformed) }); assert.fail('Expected refusal'); }
  catch (error) { assert.ok(!error.message.includes(secret)); }
  const large = Buffer.alloc(6 * 1024 * 1024 + 1); await fs.writeFile(options.current_path, large);
  await assert.rejects(compareVisualFiles({ ...options, current_sha256: visualHash(large) }), /bounds/);
});

test('pre-cancelled and mid-comparison operations abort without accepted output', async t => {
  const options = await files(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(compareVisualFiles(options, controller.signal));
  await assert.rejects(fs.stat(options.output_directory), /ENOENT/);
  const large = png(1280, 1024), later = new AbortController();
  setImmediate(() => later.abort());
  await assert.rejects(compareVisualPixels(large, large, {}, later.signal));
});

async function scenarioFixture(t, different = false, mutateEpoch = false) {
  const options = await files(t, png(4, 4), png(4, 4, data => { if (different) data[0] = 255; }));
  const elfPath = path.join(path.dirname(options.baseline_path), 'game.elf'), bytes = Buffer.alloc(128);
  bytes.set(Buffer.from('7f454c4601010100', 'hex')); bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(8, 18);
  bytes.writeUInt32LE(1, 20); bytes.writeUInt32LE(0x100000, 24); bytes.writeUInt32LE(52, 28);
  bytes.writeUInt16LE(52, 40); bytes.writeUInt16LE(32, 42); bytes.writeUInt16LE(1, 44);
  bytes.writeUInt32LE(1, 52); bytes.writeUInt32LE(0x100000, 60);
  bytes.writeUInt32LE(128, 68); bytes.writeUInt32LE(128, 72); bytes.writeUInt32LE(5, 76);
  await fs.writeFile(elfPath, bytes); const elf = await inspectSourceElf(elfPath);
  let captured = false;
  const { client, mock } = await workflowFixture(t, request => {
    if (request.cmd === 'capabilities') return { ...capabilities, elf: 'host:' + elfPath, elf_crc: elf.elf_crc, execution_epoch: captured && mutateEpoch ? 2 : 1 };
    if (request.cmd === 'screenshot') { captured = true; return { ok: true, width: 4, height: 4, mime_type: 'image/png', data: png(4, 4, data => { if (different) data[0] = 255; }).toString('base64') }; }
  });
  const step = { action: 'assert_screenshot', width: 4, height: 4, baseline_path: options.baseline_path,
    baseline_sha256: options.baseline_sha256, expected_elf_sha256: elf.sha256 };
  return { options, step, client, mock };
}

test('scenario visual assertion preserves sampled build/epoch, artifact hashes and paused CPU state', async t => {
  const f = await scenarioFixture(t);
  const report = await new ScenarioRunner().run(f.client, { name: 'visual-pass', steps: [f.step] }, f.options.output_directory);
  assert.ok(report.passed); assert.ok(report.final_paused);
  const visual = report.steps[0].result; assert.ok(visual.passed);
  assert.equal(visual.observation.elf_sha256, f.step.expected_elf_sha256); assert.equal(visual.observation.execution_epoch, 1);
  assert.ok(!f.mock.requests.some(request => ['frame_advance', 'resume', 'set_pc', 'write_memory'].includes(request.cmd)));
});

test('visual regression fails the scenario, preserves per-region artifacts and prevents later frames', async t => {
  const f = await scenarioFixture(t, true);
  const report = await new ScenarioRunner().run(f.client, { name: 'visual-fail', steps: [f.step, { action: 'frames', frames: 5 }] }, f.options.output_directory);
  assert.equal(report.passed, false); assert.equal(report.steps.length, 1); assert.ok(report.final_paused);
  assert.equal(report.steps[0].result.regions[0].pixels_over_tolerance, 1);
  assert.ok((await fs.stat(report.steps[0].result.artifacts.diff.path)).isFile());
  assert.ok(!f.mock.requests.some(request => request.cmd === 'frame_advance'));
});

test('wrong live ELF SHA refuses the screenshot instead of attaching a different build', async t => {
  const f = await scenarioFixture(t);
  const report = await new ScenarioRunner().run(f.client, { name: 'wrong-elf', steps: [{ ...f.step, expected_elf_sha256: '0'.repeat(64) }] }, f.options.output_directory);
  assert.equal(report.passed, false); assert.match(report.error, /ELF SHA256/);
  assert.ok(!f.mock.requests.some(request => request.cmd === 'screenshot'));
});

test('a hash-matching malformed reference refuses direct screenshot capture and preserves the failure reason', async t => {
  const f = await scenarioFixture(t), malformed = Buffer.from('NOT_A_PNG'.repeat(10));
  await fs.writeFile(f.step.baseline_path, malformed);
  const report = await new ScenarioRunner().run(f.client, { name: 'bad-reference', steps: [
    { ...f.step, baseline_sha256: visualHash(malformed) },
  ] }, f.options.output_directory);
  assert.equal(report.passed, false); assert.match(report.error, /visual PNG/);
  assert.ok(!f.mock.requests.some(request => request.cmd === 'screenshot'));
});

test('execution-epoch change during capture prevents comparison and diagnostic/final-pause mutations of the changed VM', async t => {
  const f = await scenarioFixture(t, false, true);
  const report = await new ScenarioRunner().run(f.client, { name: 'epoch-change', steps: [f.step] }, f.options.output_directory);
  assert.equal(report.passed, false); assert.equal(report.vm_changed, true);
  assert.match(report.error, /identity changed/); assert.equal(report.final_paused, false);
  assert.equal(f.mock.requests.filter(request => request.cmd === 'pause').length, 1);
  assert.ok(!f.mock.requests.some(request => request.cmd === 'capture_context'));
});
