import { z } from 'zod';
import { address } from './symbols.js';

export const guardedStepResponse = z.object({
  ok: z.literal(true), operation_id: z.number().int().positive().safe(),
  execution_epoch: z.number().int().nonnegative().safe(), active: z.boolean(), paused: z.boolean(),
  cleanup_complete: z.boolean(), reason: z.string(), old_pc: address, pc: address, target: address, opcode: address,
  instruction_units: z.number().int().min(1).max(2), is_call: z.boolean(), is_return: z.boolean(), cause: address, epc: address,
});
export type StepIdentity = { process_id: number; session: number; elf: string; elf_crc: string; execution_epoch: number };
