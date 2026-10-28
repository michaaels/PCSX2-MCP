import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DebugServerClient } from './debug-server-client.js';
import type { PineClient } from './pine-client.js';
import { sifIdentity, type SifIdentity } from './sif-state.js';

export const stateSlot = z.number().int().min(0).max(9);
export const stateOperationId = z.string().regex(/^[\da-f]{32}$/);
const receiptSchema = z.object({ ok: z.literal(true), operation_id: stateOperationId, slot: stateSlot,
  completed: z.literal(true), loaded: z.boolean(), paused: z.boolean(),
  before: sifIdentity, after: sifIdentity, error: z.string() }).superRefine((r, ctx) => {
  if (r.before.process_id !== r.after.process_id || r.before.session !== r.after.session ||
      r.after.execution_epoch < r.before.execution_epoch || r.loaded && r.after.execution_epoch <= r.before.execution_epoch ||
      r.loaded && r.error !== '' || !r.loaded && r.error === '')
    ctx.addIssue({ code: 'custom', message: 'Inconsistent native state-load receipt' });
});
export function parseStateLoadReceipt(value: unknown, id: string, expected?: SifIdentity) {
  const receipt = receiptSchema.parse(value);
  if (receipt.operation_id !== id) throw new Error('State-load operation receipt ID mismatch');
  if (expected) for (const key of Object.keys(sifIdentity.shape) as (keyof SifIdentity)[])
    if (receipt.before[key] !== expected[key]) throw new Error('State-load starting identity mismatch');
  return receipt;
}
const observed = (receipt: z.infer<typeof receiptSchema>, cancelled: boolean) => ({
  backend: 'debugserver', operation_id: receipt.operation_id, slot: receipt.slot,
  outcome: receipt.loaded ? 'loaded' : 'failed', request_dispatched: true, completion_confirmed: true,
  loaded: receipt.loaded, cancellation_requested: cancelled, receipt,
});

export async function performStateLoad(client: DebugServerClient | null, pine: PineClient | null, input: unknown, signal?: AbortSignal) {
  const slot = stateSlot.parse(input), id = randomUUID().replaceAll('-', '');
  let dispatched = false, known: z.infer<typeof receiptSchema> | undefined;
  const cancelled = () => ({ operation_id: id, slot, outcome: 'cancelled_before_dispatch', request_dispatched: false,
    completion_confirmed: true, loaded: false, cancellation_requested: true });
  try {
    if (signal?.aborted) return cancelled();
    if (client?.isConnected()) {
      return await client.withExclusiveSession(async () => {
        const caps = await client.getCapabilities();
        if (signal?.aborted) return cancelled();
        if (caps.features.includes('guarded_state_load')) {
          const expected = sifIdentity.parse(caps);
          if (!(await client.getStatus()).paused) throw new Error('Pause the VM before loading a state');
          if (signal?.aborted) return cancelled();
          dispatched = true;
          const raw = await client.requestStateLoad(id, slot, expected);
          const parsed = parseStateLoadReceipt(raw, id, expected);
          if (parsed.slot !== slot) throw new Error('State-load slot mismatch');
          known = parsed;
          // Cancellation after dispatch must not conceal a completed guest mutation.
          return observed(known, signal?.aborted ?? false);
        }
        if (!pine?.isConnected()) throw new Error('Rebuild PCSX2: guarded_state_load required, or connect PINE for unconfirmed submission');
        if (signal?.aborted) return cancelled();
        dispatched = true; await pine.loadState(slot);
        return { backend: 'pine', operation_id: id, slot, outcome: 'queued_unconfirmed', request_dispatched: true,
          completion_confirmed: false, loaded: null, cancellation_requested: signal?.aborted ?? false };
      });
    }
    if (!pine?.isConnected()) throw new Error('Connect DebugServer or PINE before loading a state');
    if (signal?.aborted) return cancelled();
    dispatched = true; await pine.loadState(slot);
    return { backend: 'pine', operation_id: id, slot, outcome: 'queued_unconfirmed', request_dispatched: true,
      completion_confirmed: false, loaded: null, cancellation_requested: signal?.aborted ?? false };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'State load failed';
    if (known) return { ...observed(known, signal?.aborted ?? false), connection_error_after_receipt: message };
    const refused = error instanceof Error && 'native_refused' in error && error.native_refused === true;
    return { operation_id: id, slot, outcome: refused ? 'refused' : dispatched ? 'unknown' : 'not_dispatched',
      request_dispatched: dispatched, completion_confirmed: refused || !dispatched, loaded: dispatched && !refused ? null : false,
      cancellation_requested: signal?.aborted ?? false, error: message };
  }
}

export async function readStateLoadStatus(client: DebugServerClient, id: string) {
  stateOperationId.parse(id);
  return client.withExclusiveSession(async () => {
    const caps = await client.getCapabilities();
    if (!caps.features.includes('guarded_state_load')) throw new Error('Rebuild PCSX2: guarded_state_load required');
    const receipt = parseStateLoadReceipt(await client.stateLoadReceipt(id), id);
    if (caps.process_id !== receipt.after.process_id || caps.session !== receipt.after.session)
      throw new Error('State-load receipt belongs to a different native session');
    const current = sifIdentity.parse(await client.getCapabilities());
    if (current.process_id !== caps.process_id || current.session !== caps.session) throw new Error('Native session changed while reading state-load receipt');
    return { ...observed(receipt, false), current_identity: current,
      historical: (Object.keys(sifIdentity.shape) as (keyof SifIdentity)[]).some(key => current[key] !== receipt.after[key]),
      retention: 'last_completed_guarded_state_load_in_this_native_server_session' };
  });
}

export function registerStateTools(server: McpServer, getClient: () => DebugServerClient | null, getPine: () => PineClient | null) {
  server.tool('pcsx2_load_state', 'Load slot 0-9. With rebuilt guarded_state_load DebugServer, requires paused VM and validates identity; returns actual native loaded/failed receipt. PINE-only fallback reports queued_unconfirmed, never Loaded. Cancellation before dispatch performs no load; in-flight native loads cannot be cancelled and their actual outcome is retained. Transport loss is unknown; use pcsx2_load_state_status instead of retrying. Receipt retention is one completed operation per native session.',
    { slot: stateSlot }, async ({ slot }, extra) => {
      const result = await performStateLoad(getClient(), getPine(), slot, extra.signal);
      return { ...(result.outcome === 'failed' || result.outcome === 'refused' || result.outcome === 'unknown' || result.outcome === 'not_dispatched' ? { isError: true } : {}),
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    });
  server.tool('pcsx2_load_state_status', 'Read the last completed guarded state-load receipt by its operation ID, without loading again. Can be historical after reset/restore; no receipt means unavailable/unknown, not proof that no load ran. Requires rebuilt DebugServer. A subsequent load or server restart discards the previous receipt.',
    { operation_id: stateOperationId }, async ({ operation_id }) => {
      try {
        const client = getClient(); if (!client?.isConnected()) throw new Error('Connect DebugServer first');
        return { content: [{ type: 'text' as const, text: JSON.stringify(await readStateLoadStatus(client, operation_id), null, 2) }] };
      } catch (error) { return { isError: true, content: [{ type: 'text' as const,
        text: JSON.stringify({ outcome: 'unavailable_or_unknown', error: error instanceof Error ? error.message : 'State-load receipt unavailable' }) }] }; }
    });
}
