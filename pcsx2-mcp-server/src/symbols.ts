import { z } from 'zod';

export const address = z.string().regex(/^(?:0x)?[\da-fA-F]{1,8}$/);
export const cpu = z.enum(['ee', 'iop']).default('ee');
export const symbolOptions = z.object({
  query: z.string().max(256).default(''), kind: z.enum(['all', 'function', 'global']).default('all'),
  exact: z.boolean().default(false), offset: z.number().int().min(0).max(1000000).default(0),
  limit: z.number().int().min(1).max(100).default(50), cpu,
});
const symbol = z.object({ name: z.string(), kind: z.enum(['function', 'global']), address,
  size: z.number().int().min(0).max(0xffffffff), source_file: z.string() });
const identity = z.object({ ok: z.literal(true), session: z.number().int().nonnegative(), elf: z.string(), elf_crc: address });
export const symbolsResponse = identity.extend({ symbols: z.array(symbol).max(100), total_matches: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative(), has_more: z.boolean() });
export const resolvedResponse = identity.extend({ address, symbols: z.array(symbol).max(100) });
export const symbolBreakpointResponse = identity.extend({ name: z.string(), address });
export type SymbolOptions = z.input<typeof symbolOptions>;
