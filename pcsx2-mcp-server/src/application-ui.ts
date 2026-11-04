import { z } from 'zod';
import { DebugServerClient } from './debug-server-client.js';
import { parseScreenshot } from './screenshot.js';
import { setTimeout as delay } from 'node:timers/promises';
import * as path from 'node:path';

const port = z.number().int().min(1).max(65535);
const id = z.string().uuid();
export const uiIdentity = z.object({ protocol_version: z.literal(1), service_id: id,
  process_id: z.number().int().positive(), ui_port: port, data_directory: z.string().max(32768),
  scope: z.literal('pcsx2_qt_application') });
export type UIIdentity = z.infer<typeof uiIdentity>;
const envelope = z.object({ ok: z.boolean(), error: z.string().max(4096).optional(), identity: uiIdentity }).passthrough();
const receipt = z.object({ action_id: id, state: z.enum(['queued', 'running', 'completed', 'failed', 'expired']),
  action: z.string(), error: z.string().max(4096).optional() }).passthrough();
export const uiSnapshotOptions = z.object({ window_id: id.optional(), max_nodes: z.number().int().min(1).max(5000).default(2000),
  max_depth: z.number().int().min(1).max(32).default(16), max_items: z.number().int().min(0).max(512).default(128) });
export const uiActionOptions = z.object({ snapshot_id: id, control_id: z.string().regex(/^c\d{1,4}$/),
  action: z.enum(['trigger', 'click', 'close', 'set_checked', 'set_check_state', 'set_text', 'select_index', 'set_value', 'focus', 'key',
    'select', 'edit_text', 'expand', 'collapse', 'mouse', 'wheel', 'context_menu', 'window_state', 'set_geometry']),
  text: z.string().max(16384).refine(value => Buffer.byteLength(value, 'utf8') <= 16384, 'Text exceeds 16384 UTF-8 bytes').optional(),
  checked: z.boolean().optional(), check_state: z.number().int().min(0).max(2).optional(), index: z.number().int().min(0).max(1000000).optional(), value: z.number().finite().optional(),
  key: z.string().min(1).max(64).optional(), x: z.number().int().min(0).max(65535).optional(),
  y: z.number().int().min(0).max(65535).optional(), button: z.enum(['left', 'right', 'middle']).optional(),
  delta_x: z.number().int().min(-1200).max(1200).optional(), delta_y: z.number().int().min(-1200).max(1200).optional(),
  double_click: z.boolean().optional(), state: z.enum(['normal', 'minimized', 'maximized']).optional(),
  geometry: z.object({ x: z.number().int().min(-32768).max(32768), y: z.number().int().min(-32768).max(32768),
    width: z.number().int().min(160).max(4096), height: z.number().int().min(120).max(2160) }).strict().optional() }).strict();

export function defaultUIPort(environment: NodeJS.ProcessEnv = process.env): number {
  if (environment.PCSX2_UI_PORT !== undefined) return port.parse(Number(environment.PCSX2_UI_PORT));
  return 21513;
}

type Transport = Pick<DebugServerClient, 'connect' | 'disconnect' | 'isConnected' | 'applicationUICommand'>;
/** Own a separate frontend connection. A queued action is never replayed after reconnect. */
export class ApplicationUIClient {
  private client: Transport | null = null;
  private identity: UIIdentity | null = null;
  constructor(private factory: (port: number) => Transport = value => new DebugServerClient('127.0.0.1', value)) {}

  disconnect() { this.client?.disconnect(); this.client = null; this.identity = null; }
  isConnected() { return !!this.identity && !!this.client?.isConnected(); }
  getIdentity() { return this.identity ? { ...this.identity } : null; }

  async connect(input: { ui_port?: number; expected_process_id?: number; expected_data_directory?: string } = {}) {
    const options = z.object({ ui_port: port.optional(), expected_process_id: z.number().int().positive().optional(),
      expected_data_directory: z.string().max(32768).optional() }).strict().parse(input);
    this.disconnect();
    const uiPort = options.ui_port ?? defaultUIPort();
    const candidate = this.factory(uiPort); this.client = candidate;
    try {
      await candidate.connect();
      const response = envelope.parse(await candidate.applicationUICommand('ui_status'));
      if (!response.ok) throw new Error(response.error ?? 'Qt UI service refused connection');
      const identity = response.identity;
      if (identity.ui_port !== uiPort || (options.expected_process_id !== undefined && identity.process_id !== options.expected_process_id) ||
          (options.expected_data_directory !== undefined && path.resolve(identity.data_directory) !== path.resolve(options.expected_data_directory)))
        throw new Error('Qt UI service process/port/data-directory mismatch');
      if (this.client !== candidate) throw new Error('UI connection changed during connect');
      this.identity = identity;
      return { identity, features: response.features };
    } catch (error) { candidate.disconnect(); if (this.client === candidate) { this.client = null; this.identity = null; } throw error; }
  }

  private async request(command: Parameters<Transport['applicationUICommand']>[0], input: Record<string, unknown> = {}) {
    const client = this.client, identity = this.identity;
    if (!identity || !client?.isConnected()) throw new Error('Qt UI service not connected; use pcsx2_ui_connect');
    const response = envelope.parse(await client.applicationUICommand(command, { ...input,
      expected_service_id: identity.service_id, expected_process_id: identity.process_id }));
    if (this.client !== client || this.identity !== identity) throw new Error('UI connection changed during request');
    for (const key of ['service_id', 'process_id', 'ui_port', 'data_directory', 'protocol_version', 'scope'] as const)
      if (response.identity[key] !== identity[key]) { this.disconnect(); throw new Error('Qt UI service identity changed'); }
    if (!response.ok) throw new Error(response.error ?? 'Qt UI request failed');
    return response;
  }

  status() { return this.request('ui_status'); }
  async snapshot(input: unknown = {}) {
    const options = uiSnapshotOptions.parse(input);
    const response = await this.request('ui_snapshot', options);
    return z.object({ snapshot_id: id, created_at_ms: z.number().int(), expires_at_ms: z.number().int(), window_id: z.string(),
      windows: z.array(z.object({ window_id: id, title: z.string(), class: z.string() }).passthrough()).max(129),
      controls: z.array(z.object({ id: z.string().regex(/^c\d{1,4}$/), parent_id: z.string(), class: z.string(),
        kind: z.enum(['widget', 'action', 'model_item', 'surface']), actions: z.array(z.string()).max(20) }).passthrough()).max(options.max_nodes),
      truncated: z.boolean(), identity: uiIdentity }).passthrough().parse(response);
  }

  async action(input: unknown) {
    const options = uiActionOptions.parse(input);
    const required: Record<string, string[]> = { set_text: ['text'], edit_text: ['text'], set_checked: ['checked'], set_check_state: ['check_state'],
      select_index: ['index'], set_value: ['value'], key: ['key'], wheel: ['x', 'y', 'delta_y'], window_state: ['state'], set_geometry: ['geometry'] };
    for (const field of required[options.action] ?? []) if (!(field in options)) throw new Error(`${options.action} requires ${field}`);
    if (options.action === 'key' && options.text && options.text.length > 32) throw new Error('Key text exceeds 32 characters');
    const response = await this.request('ui_action', { ...options, deadline_ms: Date.now() + 4000 });
    return { identity: response.identity, action: receipt.parse(response.action),
      interpretation: 'Queued receipt is not proof of a visible result. Inspect UI/status; never blindly retry an action.' };
  }

  async actionStatus(input: { action_id: string; wait_ms?: number }) {
    const options = z.object({ action_id: id, wait_ms: z.number().int().min(0).max(2000).default(0) }).strict().parse(input);
    const deadline = performance.now() + options.wait_ms;
    for (;;) {
      const response = await this.request('ui_action_status', { action_id: options.action_id });
      const result = receipt.parse(response.action);
      if (!['queued', 'running'].includes(result.state) || performance.now() >= deadline) return { identity: response.identity, action: result };
      await delay(Math.min(25, Math.max(0, deadline - performance.now())));
    }
  }

  async screenshot(input: { snapshot_id: string; window_id: string; width?: number; height?: number }) {
    const options = z.object({ snapshot_id: id, window_id: id, width: z.number().int().min(1).max(2560).default(1920),
      height: z.number().int().min(1).max(1600).default(1440) }).strict().parse(input);
    const response = await this.request('ui_screenshot', options);
    if (response.window_id !== options.window_id) throw new Error('UI screenshot window identity mismatch');
    return { ...parseScreenshot(response, options.width, options.height), identity: response.identity, window_id: options.window_id,
      capture_method: response.capture_method, occlusion_possible: response.occlusion_possible };
  }
}
