import { z } from 'zod';

export const tcpPort = z.number().int().min(1).max(65535);

function envPort(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be a decimal TCP port (1-65535)`);
  const result = tcpPort.safeParse(Number(value));
  if (!result.success) throw new Error(`${name} must be a decimal TCP port (1-65535)`);
  return result.data;
}

// Environment defaults and explicit tool arguments use the same validation.
export function defaultPorts(env: NodeJS.ProcessEnv = process.env) {
  return { debug: envPort(env, 'PCSX2_DEBUG_PORT', 21512), pine: envPort(env, 'PCSX2_PINE_PORT', 28011) };
}
