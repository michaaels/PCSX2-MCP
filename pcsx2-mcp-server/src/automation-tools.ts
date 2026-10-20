import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { inputOptions } from './automation.js';
import { DebugServerClient } from './debug-server-client.js';
import { EmulatorLauncher } from './emulator-launcher.js';

const text = (value: unknown) => ({ type: 'text' as const, text: JSON.stringify(value, null, 2) });
const frames = z.number().int().min(1).max(600).default(1);
const timeout = z.number().int().min(1).max(30000).default(20000);

export function registerAutomationTools(server: McpServer, getClient: () => DebugServerClient | null, setClient: (client: DebugServerClient) => void) {
  const launcher = new EmulatorLauncher();
  async function run(operation: () => Promise<any>) {
    try { return await operation(); }
    catch (error) { return { content: [text({ error: error instanceof Error ? error.message : String(error) })], isError: true }; }
  }
  function connected() {
    const client = getClient();
    if (!client?.isConnected()) throw new Error('Connect to the updated DebugServer first');
    return client;
  }

  server.tool('pcsx2_launch', 'Launch the patched PCSX2 with a homebrew ELF and connect automatically. Requires absolute local executable/ELF paths and a configured BIOS. Refuses an occupied debug port. Returns ELF SHA256/entry and verifies the native process ID. DebugServer readiness does not mean the game is ready.',
    { executable: z.string().min(1), elf: z.string().min(1), portable: z.boolean().default(true), timeout_ms: timeout },
    ({ executable, elf, portable, timeout_ms }, extra) => run(async () => {
      if (getClient()?.isConnected()) throw new Error('Already connected to an emulator; disconnect/stop it before launching another');
      const launched = await launcher.launch({ executable, elf, portable, timeoutMs: timeout_ms, signal: extra.signal });
      setClient(launched.client);
      return { content: [text(launched.result)] };
    }));

  server.tool('pcsx2_stop', 'Terminate only the PCSX2 process launched by this MCP instance. Unsaved emulator state is lost. Refuses externally attached instances. A game left running across an MCP restart becomes an externally attached instance.', {},
    () => run(async () => ({ content: [text(await launcher.stop())] })));

  server.tool('pcsx2_frame_advance', 'From a paused VM, run 1-600 video VSync steps and pause again. These are guest video boundaries, not host FPS or guaranteed unique screenshots. Reports early breakpoint/manual interruption. Cancellation/timeout requests a stop and clears remaining frames.',
    { frames, timeout_ms: timeout }, ({ frames, timeout_ms }, extra) => run(async () => {
      const result = await connected().advanceFrames(frames, { timeoutMs: timeout_ms, signal: extra.signal });
      return { content: [text(result)], isError: !result.completed };
    }));

  server.tool('pcsx2_input', 'From a paused VM, hold a DualShock2 button combination and raw analog positions for N video VSync steps, then restore the prior controller state and pause. controller 0/1 means port 1/2, slot 1. Analog values: 0-255, neutral 127. Requires exclusive controller use during the operation; recording/hardcore modes are rejected.',
    { ...inputOptions.shape, frames, timeout_ms: timeout },
    ({ frames, timeout_ms, ...input }, extra) => run(async () => {
      const result = await connected().advanceFrames(frames, { input, timeoutMs: timeout_ms, signal: extra.signal });
      return { content: [text(result)], isError: !result.completed };
    }));

  server.tool('pcsx2_get_controller', 'Inspect the current virtual DualShock2 buttons and raw analog positions for port 1/2, slot 1. Useful for verifying automation and controller restoration.',
    { controller: inputOptions.shape.controller }, ({ controller }) => run(async () => ({ content: [text(await connected().getController(controller))] })));
}
