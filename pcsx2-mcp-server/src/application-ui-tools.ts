import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApplicationUIClient, uiSnapshotOptions, uiActionOptions } from './application-ui.js';

/** GUI controls intentionally use their own connection, including with no VM. */
export function registerApplicationUITools(server: McpServer, client = new ApplicationUIClient()) {
  const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
  async function run(operation: () => Promise<unknown>) {
    try { return text(await operation()); }
    catch (error) { return { ...text({ error: error instanceof Error ? error.message : String(error) }), isError: true }; }
  }
  server.tool('pcsx2_ui_connect', 'Connect to the local PCSX2 Qt GUI service, independently of VM/DebugServer. Default port PCSX2_UI_PORT or 21513; never derived from the debug/PINE port. Set a distinct UI port per instance. Requires the rebuilt Qt UI integration and matching Qt Network runtime.',
    { ui_port: z.number().int().min(1).max(65535).optional(), expected_process_id: z.number().int().positive().optional(),
      expected_data_directory: z.string().max(32768).optional() }, input => run(() => client.connect(input)));
  server.tool('pcsx2_ui_disconnect', 'Disconnect this Qt GUI client; does not close PCSX2 or reverse actions already started.', {},
    async () => { client.disconnect(); return text({ disconnected: true }); });
  server.tool('pcsx2_ui_status', 'Read the connected frontend service identity/capabilities. Works before boot and after VM shutdown.', {}, () => run(() => client.status()));
  server.tool('pcsx2_ui_snapshot', 'Inspect Qt windows, controls, actions, tabs and bounded model items. IDs are connection/snapshot-scoped and expire in 120 seconds. Default root is the active modal/popup/window. A new snapshot replaces prior control IDs; truncated output is explicit.',
    uiSnapshotOptions.shape, input => run(() => client.snapshot(input)));
  server.tool('pcsx2_ui_action', 'Send one Qt-local GUI action using a fresh snapshot/control ID and its listed actions. Consumes the snapshot. Action returns a queued receipt, not visible-result acceptance; poll status and inspect again. Supports controls/models, Qt-local key/mouse/context events and managed-window normal/minimized/maximized state or bounded geometry. Geometry uses logical Qt screen coordinates within one available screen; restore normal state first. No global OS input. Opening a modal may keep its action running until closed. No blind action retries.',
    uiActionOptions.shape, input => run(() => client.action(input)));
  server.tool('pcsx2_ui_action_status', 'Read an action receipt on its originating UI connection. Optional bounded wait; running can mean an open modal. Completed means the Qt handler returned; verify the actual visible/native result separately.',
    { action_id: z.string().uuid(), wait_ms: z.number().int().min(0).max(2000).default(0) }, input => run(() => client.actionStatus(input)));
  server.tool('pcsx2_ui_screenshot', 'Capture a visible Qt window/dialog/menu or rendered DisplaySurface from the connected application, including without a VM. Requires its window ID and an unconsumed snapshot; returns PNG. Widgets use Qt rendering; DisplaySurface reads active D3D11 RGBA8/BGRA8 presentation with ImGui before Present. Other surface backends time out explicitly; no desktop fallback. For guest pixels use pcsx2_screenshot.',
    { snapshot_id: z.string().uuid(), window_id: z.string().uuid(), width: z.number().int().min(1).max(2560).default(1920),
      height: z.number().int().min(1).max(1600).default(1440) }, async input => {
      try {
        const image = await client.screenshot(input);
        const { data, ...metadata } = image;
        return { content: [{ type: 'text' as const, text: JSON.stringify(metadata, null, 2) },
          { type: 'image' as const, mimeType: 'image/png', data }] };
      } catch (error) { return { ...text({ error: error instanceof Error ? error.message : String(error) }), isError: true }; }
    });
  return () => client.disconnect();
}
