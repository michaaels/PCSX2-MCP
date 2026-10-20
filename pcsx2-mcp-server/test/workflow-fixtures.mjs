import { DebugServerClient } from '../dist/debug-server-client.js';
import { debugServer, history, screenshot, contextResponse } from './fixtures.mjs';

export const capabilities = { ok: true, protocol_version: 2, process_id: 42, session: 1, elf: 'host:game.elf', elf_crc: '0x12345678', features: ['symbols'] };
export const functionSymbol = { name: 'main', kind: 'function', address: '0x00100000', size: 64, source_file: 'main.c' };

export async function workflowFixture(t, override = () => undefined) {
  let paused = false, operationId = 0, frames = 0, pc = '0x00100004', cursor = 0;
  const breakpoints = [];
  const mock = await debugServer(t, async request => {
    const supplied = await override(request);
    if (supplied !== undefined) return supplied;
    switch (request.cmd) {
      case 'capabilities': return capabilities;
      case 'import_symbols': return { ...capabilities, requested: true };
      case 'status': return { ok: true, data: { alive: true, paused, pc, cycles: 100 } };
      case 'pause': paused = true; return { ok: true, pc };
      case 'resume': paused = true; pc = breakpoints.at(-1)?.address ?? pc; cursor++; return { ok: true };
      case 'read_logs': return history('logs', request.after < cursor ? [{ sequence: cursor, timestamp_ms: 1, source: 'console', level: 3, message: 'SMS ready', truncated: false }] : [], Math.max(cursor, request.after));
      case 'read_events': return history('events', cursor > request.after ? [{ sequence: cursor, timestamp_ms: 1, type: 'breakpoint', cpu: 'ee', pc, detail: '' }] : [], Math.max(cursor, request.after));
      case 'frame_advance': case 'input_frames': operationId++; frames = request.frames; cursor++; return op(true);
      case 'automation_status': return op(false);
      case 'automation_cancel': return { ...op(false), reason: 'cancelled' };
      case 'read_memory': return { ok: true, hex: 'ab'.repeat(request.length), invalid_bytes: 0 };
      case 'evaluate': return { ok: true, result: 18446744073709551615, hex: '0xffffffffffffffff' };
      case 'controller_state': return { ok: true, controller: 0, pressed_mask: 0, left_x: 127, left_y: 127, right_x: 127, right_y: 127 };
      case 'screenshot': return screenshot();
      case 'capture_context': return contextResponse();
      case 'lookup_symbols': return { ...capabilities, symbols: [functionSymbol], total_matches: 1, next_offset: 1, has_more: false };
      case 'resolve_address': return { ...capabilities, address: request.address, symbols: [functionSymbol] };
      case 'breakpoint_symbol': return { ...capabilities, name: request.name, address: functionSymbol.address };
      case 'list_breakpoints': return { ok: true, breakpoints: [...breakpoints] };
      case 'set_breakpoint': breakpoints.push({ address: request.address }); return { ok: true };
      case 'remove_breakpoint': breakpoints.splice(breakpoints.findIndex(bp => bp.address === request.address), 1); return { ok: true };
      default: throw new Error('Unexpected fixture command: ' + request.cmd);
    }
  });
  function op(active) { return { ok: true, session: 1, operation_id: operationId, active, start_frame: 0, target_frame: frames,
    current_frame: active ? 0 : frames, frames_advanced: active ? 0 : frames, reason: active ? '' : 'completed', paused: !active }; }
  const client = new DebugServerClient('127.0.0.1', mock.port);
  await client.connect(); t.after(() => client.disconnect());
  return { client, mock };
}
