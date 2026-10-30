import { z } from 'zod';
import { parseScreenshot } from './screenshot.js';

export const applicationScreenshotOptions = z.object({
  target: z.enum(['main', 'debugger']).default('debugger'),
  width: z.number().int().min(1).max(2560).default(1920),
  height: z.number().int().min(1).max(1600).default(1440),
});
const metadata = z.object({ target: z.enum(['main', 'debugger']), source: z.literal('qt_widget'),
  window_title: z.string().max(2048) });
export function parseApplicationScreenshot(response: unknown, options: z.infer<typeof applicationScreenshotOptions>) {
  const extra = metadata.parse(response);
  if (extra.target !== options.target) throw new Error('Application screenshot target mismatch');
  return { ...parseScreenshot(response, options.width, options.height), ...extra };
}
