import { z } from 'zod';

const MAX_PNG_BYTES = 6 * 1024 * 1024;
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

const screenshotResponse = z.object({
  width: z.number().int().min(1).max(2560),
  height: z.number().int().min(1).max(1600),
  mime_type: z.literal('image/png'),
  data: z.string().min(4).max(Math.ceil(MAX_PNG_BYTES / 3) * 4),
});

export type Screenshot = { width: number; height: number; data: string };

/** Validate the binary envelope before returning it as MCP image content. */
export function parseScreenshot(response: unknown, maxWidth = 1280, maxHeight = 1024): Screenshot {
  const parsed = screenshotResponse.safeParse(response);
  if (!parsed.success) throw new Error('Invalid screenshot response from DebugServer');
  const { width, height, data } = parsed.data;
  if (width > maxWidth || height > maxHeight) throw new Error('Invalid screenshot response from DebugServer');
  const png = Buffer.from(data, 'base64');
  if (png.length > MAX_PNG_BYTES || png.toString('base64') !== data ||
      png.length < 45 || !png.subarray(0, 8).equals(pngSignature) ||
      png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR' ||
      png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height ||
      png.readUInt32BE(png.length - 12) !== 0 || png.toString('ascii', png.length - 8, png.length - 4) !== 'IEND') {
    throw new Error('Invalid PNG screenshot from DebugServer');
  }
  return { width, height, data };
}
