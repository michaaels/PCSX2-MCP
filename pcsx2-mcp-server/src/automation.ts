import { z } from 'zod';

// Native indices are PadDualshock2::Inputs, not the PS2 packet bit order.
export const buttons = ['up', 'right', 'down', 'left', 'triangle', 'circle', 'cross', 'square',
  'select', 'start', 'l1', 'l2', 'r1', 'r2', 'l3', 'r3'] as const;
export const inputOptions = z.object({
  controller: z.number().int().min(0).max(1).default(0),
  buttons: z.array(z.enum(buttons)).max(16).default([]),
  left_x: z.number().int().min(0).max(255).default(127),
  left_y: z.number().int().min(0).max(255).default(127),
  right_x: z.number().int().min(0).max(255).default(127),
  right_y: z.number().int().min(0).max(255).default(127),
});
export const automationResponse = z.object({
  ok: z.literal(true), session: z.number().int().nonnegative(),
  operation_id: z.number().int().positive(), active: z.boolean(),
  start_frame: z.number().int().nonnegative(), target_frame: z.number().int().nonnegative(),
  current_frame: z.number().int().nonnegative(), frames_advanced: z.number().int().nonnegative(),
  reason: z.string(), paused: z.boolean(),
});
export const controllerResponse = inputOptions.omit({ buttons: true }).extend({
  ok: z.literal(true), pressed_mask: z.number().int().min(0).max(65535),
});
export type InputOptions = z.input<typeof inputOptions>;
