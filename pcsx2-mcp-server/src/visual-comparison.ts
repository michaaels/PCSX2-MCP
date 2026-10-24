import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { PNG } from 'pngjs';

export const absoluteVisualPath = z.string().min(1).max(4096).refine(p => path.isAbsolute(p) && !/[\x00-\x1f]/.test(p), 'Absolute local path required');
export const visualSHA = z.string().regex(/^[a-f\d]{64}$/i).transform(s => s.toLowerCase());
const tolerance = z.number().int().min(0).max(255), fraction = z.number().finite().min(0).max(1);
const rectangle = z.object({ x: z.number().int().min(0).max(1279), y: z.number().int().min(0).max(1023),
  width: z.number().int().min(1).max(1280), height: z.number().int().min(1).max(1024) }).strict();
const region = rectangle.extend({ name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  channel_tolerance: tolerance.optional(), max_changed_fraction: fraction.optional() }).strict();
export const visualPolicy = z.object({ channel_tolerance: tolerance.default(0), max_changed_fraction: fraction.default(0),
  regions: z.array(region).max(16).default([]), ignore_regions: z.array(rectangle).max(16).default([]) }).strict();
export const visualFileOptions = z.object({ baseline_path: absoluteVisualPath, baseline_sha256: visualSHA,
  current_path: absoluteVisualPath, current_sha256: visualSHA, output_directory: absoluteVisualPath,
  policy: visualPolicy.default({}) }).strict();
export const visualAssertionOptions = z.object({ baseline_path: absoluteVisualPath, baseline_sha256: visualSHA,
  expected_elf_sha256: visualSHA, policy: visualPolicy.default({}) }).strict();
export const visualHash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const MAX_PNG = 6 * 1024 * 1024;
const signature = Buffer.from('89504e470d0a1a0a', 'hex');
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); return value >>> 0;
});
function crc32(bytes: Buffer) {
  let crc = 0xffffffff; for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]; return (crc ^ 0xffffffff) >>> 0;
}

/** Bound/validate the PNG before handing it to the pinned decoder. */
export function decodeVisualPng(bytes: Buffer) {
  if (bytes.length < 57 || bytes.length > MAX_PNG || !bytes.subarray(0, 8).equals(signature)) throw new Error('Invalid or oversized visual PNG');
  let offset = 8, chunks = 0, width = 0, height = 0, channels = 0, dataSeen = false, dataEnded = false, ended = false;
  const compressed: Buffer[] = [];
  while (offset < bytes.length) {
    if (++chunks > 4096 || offset + 12 > bytes.length) throw new Error('Invalid visual PNG chunk bounds');
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) throw new Error('Truncated visual PNG chunk');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || /[a-z]/.test(type[2]) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4))
      throw new Error('Invalid visual PNG chunk type or CRC');
    if (chunks === 1 && type !== 'IHDR') throw new Error('Visual PNG must start with IHDR');
    if (type === 'IHDR') {
      if (chunks !== 1 || length !== 13) throw new Error('Invalid visual PNG IHDR');
      width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12);
      const depth = bytes[offset + 16], color = bytes[offset + 17]; channels = color === 2 ? 3 : 4;
      if (width < 1 || width > 1280 || height < 1 || height > 1024 || depth !== 8 || ![2, 6].includes(color) ||
          bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0)
        throw new Error('Visual PNG requires noninterlaced 8-bit RGB/RGBA within 1280x1024');
    } else if (type === 'IDAT') {
      if (dataEnded) throw new Error('Nonconsecutive visual PNG IDAT chunks');
      dataSeen = true; compressed.push(bytes.subarray(offset + 8, end - 4));
    } else if (type === 'IEND') {
      if (length || !dataSeen || end !== bytes.length) throw new Error('Invalid visual PNG end');
      ended = true;
    } else {
      if (dataSeen) dataEnded = true;
      if (['acTL', 'fcTL', 'fdAT'].includes(type) || /[A-Z]/.test(type[0])) throw new Error('Unsupported visual PNG chunk');
    }
    offset = end;
  }
  if (!ended) throw new Error('Missing visual PNG IEND');
  const expected = height * (1 + width * channels);
  try {
    // pngjs limits noninterlaced output too; this additionally refuses surplus
    // inflated scanlines instead of accepting a truncated decompression result.
    const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
    if (raw.length !== expected) throw new Error('Scanline extent');
    const image = PNG.sync.read(bytes, { checkCRC: true });
    if (image.width !== width || image.height !== height || image.data.length !== width * height * 4) throw new Error('Decoded extent');
    for (let i = 3; i < image.data.length; i += 4) if (image.data[i] !== 255) throw new Error('Alpha');
    return { width, height, data: image.data };
  } catch { throw new Error('Invalid visual PNG pixels, scanlines or opacity'); }
}

export async function readVisualReference(filename: string, expected: string, signal?: AbortSignal) {
  absoluteVisualPath.parse(filename); const expectedSHA = visualSHA.parse(expected); signal?.throwIfAborted();
  const file = await fs.open(filename, 'r').catch(() => { throw new Error('Cannot open visual PNG file'); });
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size < 57n || before.size > BigInt(MAX_PNG)) throw new Error('Visual PNG file exceeds bounds');
    const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted(); const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error('Visual PNG truncated during read'); offset += read.bytesRead;
    }
    const after = await file.stat({ bigint: true }), current = await fs.stat(filename, { bigint: true });
    for (const stat of [after, current]) for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const)
      if (stat[key] !== before[key]) throw new Error('Visual PNG changed during read');
    if (visualHash(bytes) !== expectedSHA) throw new Error('Visual PNG SHA256 mismatch');
    signal?.throwIfAborted(); return bytes;
  } finally { await file.close(); }
}

export async function compareVisualPixels(baseline: Buffer, current: Buffer, input: z.input<typeof visualPolicy> = {}, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const policy = visualPolicy.parse(input), a = decodeVisualPng(baseline), b = decodeVisualPng(current);
  const { width, height } = a;
  const selected = policy.regions.length ? policy.regions : [{ name: 'full_image', x: 0, y: 0, width, height }];
  const inside = (r: z.infer<typeof rectangle>) => r.x + r.width <= width && r.y + r.height <= height;
  if (![...selected, ...policy.ignore_regions].every(inside)) throw new Error('Visual region is outside the baseline image');
  if (new Set(selected.map(r => r.name)).size !== selected.length) throw new Error('Visual region names must be unique');
  for (let i = 0; i < selected.length; i++) for (let j = i + 1; j < selected.length; j++) {
    const r = selected[i], s = selected[j];
    if (r.x < s.x + s.width && s.x < r.x + r.width && r.y < s.y + s.height && s.y < r.y + r.height)
      throw new Error('Selected visual regions must not overlap');
  }
  if (width !== b.width || height !== b.height) return { passed: false, reason: 'dimensions_mismatch',
    baseline_dimensions: { width, height }, current_dimensions: { width: b.width, height: b.height }, policy,
    regions: [], coverage: null, diff: null };
  const ignored = new Uint8Array(width * height), diffImage = new PNG({ width, height }), diff = diffImage.data;
  for (let i = 3; i < diff.length; i += 4) diff[i] = 255;
  for (const r of policy.ignore_regions) for (let y = r.y; y < r.y + r.height; y++) ignored.fill(1, y * width + r.x, y * width + r.x + r.width);
  const regions = []; let selectedPixels = 0, ignoredPixels = 0;
  for (const r of selected) {
    const channelTolerance = r.channel_tolerance ?? policy.channel_tolerance;
    const maxFraction = r.max_changed_fraction ?? policy.max_changed_fraction;
    let compared = 0, changed = 0, different = 0, totalDelta = 0, maximum = 0;
    for (let y = r.y; y < r.y + r.height; y++) {
      if ((y - r.y) % 32 === 0) await yieldImmediate(undefined, { signal });
      for (let x = r.x; x < r.x + r.width; x++) {
        const pixel = y * width + x, at = pixel * 4; selectedPixels++;
        if (ignored[pixel]) { ignoredPixels++; diff[at] = 20; diff[at + 1] = 32; diff[at + 2] = 48; continue; }
        compared++; let delta = 0;
        for (let c = 0; c < 3; c++) { const d = Math.abs(a.data[at + c] - b.data[at + c]); totalDelta += d; delta = Math.max(delta, d); }
        maximum = Math.max(maximum, delta);
        if (delta) different++;
        if (delta > channelTolerance) { changed++; diff[at] = 255; }
        else if (delta) { diff[at] = 255; diff[at + 1] = 200; }
        else { const gray = Math.round((b.data[at] + b.data[at + 1] + b.data[at + 2]) / 12); diff[at] = diff[at + 1] = diff[at + 2] = gray; }
      }
    }
    if (!compared) throw new Error('Visual region has no unmasked pixels');
    const ratio = changed / compared;
    regions.push({ name: r.name, x: r.x, y: r.y, width: r.width, height: r.height, channel_tolerance: channelTolerance,
      max_changed_fraction: maxFraction, compared_pixels: compared, pixels_over_tolerance: changed,
      changed_fraction: ratio, pixels_with_any_difference: different, max_channel_delta: maximum,
      mean_absolute_channel_delta: totalDelta / (3 * compared), passed: ratio <= maxFraction });
  }
  signal?.throwIfAborted();
  return { passed: regions.every(r => r.passed), reason: regions.every(r => r.passed) ? 'within_tolerance' : 'pixel_regression',
    baseline_dimensions: { width, height }, current_dimensions: { width, height }, policy, regions,
    coverage: { selected_pixels: selectedPixels, ignored_pixels: ignoredPixels, compared_pixels: selectedPixels - ignoredPixels,
      outside_region_pixels: width * height - selectedPixels },
    diff: PNG.sync.write(diffImage, { colorType: 6, bitDepth: 8, inputColorType: 6, filterType: 0 }) };
}

export async function saveVisualComparison(baseline: Buffer, current: Buffer, policy: z.input<typeof visualPolicy>,
  outputDirectory: string, observation: Record<string, unknown>, signal?: AbortSignal) {
  absoluteVisualPath.parse(outputDirectory);
  const { diff, ...comparison } = await compareVisualPixels(baseline, current, policy, signal);
  signal?.throwIfAborted(); await fs.mkdir(outputDirectory, { recursive: true });
  const directory = await fs.mkdtemp(path.join(outputDirectory, 'pcsx2-visual-'));
  async function save(name: string, bytes: Buffer) {
    signal?.throwIfAborted(); const target = path.join(directory, name);
    await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    return { path: target, sha256: visualHash(bytes), size_bytes: bytes.length };
  }
  const artifacts = { baseline: await save('baseline.png', baseline), current: await save('current.png', current),
    diff: diff ? await save('diff.png', diff) : null };
  const report = { format_version: 1, kind: 'pcsx2_visual_comparison', created_at: new Date().toISOString(), ...comparison,
    policy_sha256: visualHash(JSON.stringify(comparison.policy)),
    algorithm: { id: 'max_encoded_rgb_channel_delta_v1', alpha: 'opaque_only', gamma_and_profiles: 'not_applied',
      coordinates: 'absolute_pixels_no_resize_or_alignment', threshold: 'pixel_max_channel_delta_strictly_greater_than_tolerance',
      region_verdict: 'changed_fraction_less_than_or_equal_to_budget', perceptual_or_semantic_validation: false },
    baseline_provenance: 'caller_selected_hash_pinned_reference_not_attested_build_identity', observation, artifacts };
  const artifact = await save('comparison.json', Buffer.from(JSON.stringify(report, null, 2) + '\n'));
  signal?.throwIfAborted();
  return { ...report, artifacts: { ...artifacts, report: artifact } };
}

export async function compareVisualFiles(input: z.input<typeof visualFileOptions>, signal?: AbortSignal) {
  const o = visualFileOptions.parse(input);
  const baseline = await readVisualReference(o.baseline_path, o.baseline_sha256, signal);
  const current = await readVisualReference(o.current_path, o.current_sha256, signal);
  return saveVisualComparison(baseline, current, o.policy, o.output_directory, { vm_identity: 'not_observed_offline' }, signal);
}
