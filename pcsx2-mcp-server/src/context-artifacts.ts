import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DebugServerClient } from './debug-server-client.js';

export async function writeContextArtifacts(result: Awaited<ReturnType<DebugServerClient['captureContext']>>, directory: string, prefix = '') {
  const { screenshot, ...context } = result;
  const report = { ...context, complete: screenshot.ok, screenshot: screenshot.ok
    ? { ok: true, width: screenshot.width, height: screenshot.height, mime_type: 'image/png' }
    : screenshot };
  const stem = prefix ? prefix + '-' : '';
  const artifacts = { directory, report: path.join(directory, stem + 'context.json'), screenshot: undefined as string | undefined };
  if (screenshot.ok) {
    artifacts.screenshot = path.join(directory, stem + 'frame.png');
    await fs.writeFile(artifacts.screenshot, Buffer.from(screenshot.data, 'base64'), { flag: 'wx' });
  }
  await fs.writeFile(artifacts.report, JSON.stringify({ ...report, artifacts }, null, 2), { flag: 'wx' });
  return { report, artifacts };
}
