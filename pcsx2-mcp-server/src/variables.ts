import { z } from 'zod';

const integer = z.string().max(64).regex(/^-?\d+$/);
export const variableLocation = z.object({ status: z.string().max(80), value: integer.optional(), detail: z.string().max(256).optional(),
  valid_range: z.tuple([z.number().int().min(0).max(0x100000000), z.number().int().min(0).max(0x100000000)]).optional(), default_location: z.boolean().optional(),
  ops: z.array(z.object({ op: z.string().max(64), args: z.array(integer).max(4) })).max(64).optional() });
const typeId = z.string().regex(/^\d+$/).max(24);
const member = z.object({ name: z.string().max(1024), type: typeId.nullable(), offset: z.number().int().min(0).max(0x100000000).nullable(), status: z.string().optional() });
const typeNode = z.object({ name: z.string().max(1024), kind: z.enum(['base', 'pointer', 'alias', 'struct', 'array', 'unsupported']),
  size: z.number().int().min(0).max(0x100000000).nullable(), target: typeId.nullable().optional(),
  encoding: z.number().int().nullable().optional(), count: z.number().int().min(0).max(0x100000000).nullable().optional(),
  members: z.array(member).max(32).optional(), truncated: z.boolean().optional(), detail: z.string().optional() });
export const variableMetadata = z.object({ format_version: z.literal(1), sha256: z.string().regex(/^[\da-f]{64}$/), pc: z.string(),
  dwarf_version: z.number().int().min(2).max(5), function: z.string().max(1024), id: typeId,
  ranges: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().positive()])).max(4096),
  source_line: z.number().int().nullable(), location_guard: z.enum(['compiler_reported', 'prologue', 'epilogue']), has_prologue_marker: z.boolean(),
  frame_base: variableLocation, cfa: z.object({ status: z.string(), register: z.number().int().optional(), offset: integer.optional() }),
  scopes: z.array(z.object({ id: typeId, tag: z.string(), depth: z.number().int().min(0).max(32) })).max(256),
  inline_scopes: z.array(z.object({ id: typeId, name: z.string(), status: z.string() })).max(256),
  variables: z.array(z.object({ id: typeId, name: z.string().max(1024), scope: typeId, kind: z.enum(['local', 'argument']), type: typeId.nullable(), location: variableLocation })).max(256),
  types: z.record(typeId, typeNode).refine(value => Object.keys(value).length <= 256),
});
export const variableOptions = z.object({ frame_index: z.literal(0).default(0),
  names: z.array(z.string().min(1).max(1024)).min(1).max(32).optional(),
  expected_sha256: z.string().regex(/^[\da-fA-F]{64}$/).optional(),
  max_variables: z.number().int().min(1).max(64).default(32), max_depth: z.number().int().min(0).max(4).default(2),
  max_children: z.number().int().min(1).max(32).default(16), max_nodes: z.number().int().min(16).max(256).default(128),
  max_bytes: z.number().int().min(16).max(4096).default(1024), follow_pointers: z.boolean().default(false) });
export type VariableMetadata = z.infer<typeof variableMetadata>;
type Location = z.infer<typeof variableLocation>;
type Storage = { kind: 'address' | 'value'; value: bigint } | { kind: 'register'; value: bigint; register: number };
export type Rendered = { name: string; type?: string; type_id?: string | null; size?: number | null; status: string;
  value?: string; hex?: string; address?: string; register?: number; children?: Rendered[]; truncated?: boolean; detail?: string };
export class VariableUnavailable extends Error {}
const hexAddress = (value: bigint) => {
  if (value < 0n || value > 0xffffffffn) throw new VariableUnavailable('invalid_address');
  return '0x' + value.toString(16).padStart(8, '0');
};

/** Evaluates a deliberately small location-expression subset, never source expressions. */
export class VariableReader {
  nodes = 0; bytes = 0; bytesRead = 0; reads = 0;
  private cache = new Map<string, Buffer>();
  constructor(private metadata: VariableMetadata, private gpr: string[],
    private memory: (address: string, length: number) => Promise<string>, private options: z.infer<typeof variableOptions>, private signal?: AbortSignal) {}

  private reg(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= 32) throw new VariableUnavailable('unsupported_register');
    return BigInt(this.gpr[index]);
  }
  private async load(value: bigint, length: number) {
    const address = hexAddress(value), key = `${address}:${length}`;
    this.signal?.throwIfAborted();
    const previous = this.cache.get(key); if (previous) return previous;
    if (length < 1 || length > this.options.max_bytes - this.bytes || this.reads >= 64) throw new VariableUnavailable('memory_budget');
    this.bytes += length; this.reads++;
    const hex = await this.memory(address, length);
    if (!/^(?:[\da-f]{2})+$/i.test(hex) || hex.length !== length * 2) throw new Error('Invalid guarded memory response');
    const buffer = Buffer.from(hex, 'hex'); this.bytesRead += length; this.cache.set(key, buffer); return buffer;
  }
  private cfa() {
    const cfa = this.metadata.cfa;
    if (cfa.status !== 'register_offset' || cfa.register === undefined || cfa.offset === undefined) throw new VariableUnavailable('cfa_unavailable');
    return BigInt.asUintN(32, this.reg(cfa.register)) + BigInt(cfa.offset);
  }
  async expression(location: Location, frameBase = false): Promise<Storage> {
    if (location.status === 'constant' && location.value !== undefined) return { kind: 'value', value: BigInt(location.value) };
    if (location.status !== 'expression' || !location.ops?.length) throw new VariableUnavailable(location.status);
    const stack: bigint[] = []; let value = false;
    const pop = () => { const result = stack.pop(); if (result === undefined) throw new VariableUnavailable('malformed_expression'); return result; };
    for (let index = 0; index < location.ops.length; index++) {
      this.signal?.throwIfAborted();
      const { op, args } = location.ops[index];
      const arg = (n: number) => { if (args[n] === undefined) throw new VariableUnavailable('malformed_expression'); return BigInt(args[n]); };
      if (/^DW_OP_reg(?:\d+|x)$/.test(op)) {
        if (location.ops.length !== 1) throw new VariableUnavailable('unsupported_register_expression');
        const register = op === 'DW_OP_regx' ? Number(arg(0)) : Number(op.slice(9));
        return { kind: 'register', register, value: this.reg(register) };
      }
      if (/^DW_OP_breg(?:\d+|x)$/.test(op)) {
        const register = op === 'DW_OP_bregx' ? Number(arg(0)) : Number(op.slice(10));
        stack.push(BigInt.asUintN(32, this.reg(register)) + arg(op === 'DW_OP_bregx' ? 1 : 0));
      } else if (op === 'DW_OP_fbreg') {
        if (frameBase) throw new VariableUnavailable('recursive_frame_base');
        const base = await this.expression(this.metadata.frame_base, true);
        stack.push((base.kind === 'register' ? BigInt.asUintN(32, base.value) : base.value) + arg(0));
      } else if (op === 'DW_OP_call_frame_cfa') stack.push(this.cfa());
      else if (/^DW_OP_lit\d+$/.test(op)) stack.push(BigInt(op.slice(9)));
      else if (op === 'DW_OP_addr' || /^DW_OP_const(?:[1248][us]|[us])$/.test(op)) stack.push(arg(0));
      else if (op === 'DW_OP_plus_uconst') stack.push(pop() + arg(0));
      else if (op === 'DW_OP_plus' || op === 'DW_OP_minus') { const b = pop(), a = pop(); stack.push(op === 'DW_OP_plus' ? a + b : a - b); }
      else if (op === 'DW_OP_deref' || op === 'DW_OP_deref_size') {
        const width = op === 'DW_OP_deref' ? 4 : Number(arg(0));
        if (![1, 2, 4, 8].includes(width)) throw new VariableUnavailable('unsupported_dereference_size');
        const data = await this.load(pop(), width); stack.push(BigInt('0x' + Buffer.from(data).reverse().toString('hex')));
      } else if (op === 'DW_OP_stack_value' && index === location.ops.length - 1) value = true;
      else throw new VariableUnavailable(`unsupported_expression:${op}`);
      if (stack.length > 16 || stack.some(item => item < -(1n << 127n) || item >= 1n << 128n)) throw new VariableUnavailable('expression_limit');
    }
    if (stack.length !== 1) throw new VariableUnavailable('malformed_expression');
    return { kind: value ? 'value' : 'address', value: stack[0] };
  }
  private concrete(id: string | null, seen = new Set<string>()): { id: string; node: VariableMetadata['types'][string] } {
    if (!id || seen.has(id) || !this.metadata.types[id]) throw new VariableUnavailable('unsupported_type');
    seen.add(id); const node = this.metadata.types[id];
    return node.kind === 'alias' ? this.concrete(node.target ?? null, seen) : { id, node };
  }
  private size(id: string | null, seen = new Set<string>()): number {
    const { id: key, node } = this.concrete(id);
    if (seen.has(key)) throw new VariableUnavailable('recursive_type_size');
    seen.add(key);
    const size = node.size ?? (node.kind === 'array' && node.count !== null && node.count !== undefined ? node.count * this.size(node.target ?? null, seen) : null);
    if (size === null || !Number.isSafeInteger(size) || size < 0 || size > 0x100000000) throw new VariableUnavailable('unknown_type_size');
    return size;
  }
  private display(id: string | null, depth = 0): string {
    const node = id ? this.metadata.types[id] : null;
    if (!node || depth > 8) return '<unknown>';
    if (node.name !== '<anonymous>') return node.name;
    if (node.kind === 'alias') return this.display(node.target ?? null, depth + 1);
    if (node.kind === 'pointer') return this.display(node.target ?? null, depth + 1) + '*';
    if (node.kind === 'array') return `${this.display(node.target ?? null, depth + 1)}[${node.count ?? '?'}]`;
    return `<${node.kind}>`;
  }
  private offset(storage: Storage, offset: number): Storage {
    return storage.kind === 'address' ? { kind: 'address', value: storage.value + BigInt(offset) }
      : { kind: 'value', value: storage.value >> BigInt(offset * 8) };
  }
  private async raw(storage: Storage, width: number) {
    if (storage.kind === 'address') return this.load(storage.value, width);
    if (width > 16) throw new VariableUnavailable('unsupported_register_aggregate');
    return Buffer.from(BigInt.asUintN(width * 8, storage.value).toString(16).padStart(width * 2, '0'), 'hex').reverse();
  }
  async render(name: string, id: string | null, storage: Storage, depth = 0): Promise<Rendered> {
    this.signal?.throwIfAborted(); this.nodes++;
    const result: Rendered = { name, type_id: id, type: this.display(id), status: 'available' };
    try {
      const { node } = this.concrete(id), size = this.size(id); result.size = size;
      if (storage.kind === 'address') result.address = hexAddress(storage.value);
      if (storage.kind === 'register') result.register = storage.register;
      if (node.kind === 'base' || node.kind === 'pointer') {
        if (![1, 2, 4, 8].includes(size) || (node.kind === 'pointer' && size !== 4)) throw new VariableUnavailable('unsupported_scalar_size');
        if (node.kind === 'base' && ![1, 2, 4, 5, 6, 7, 8].includes(node.encoding ?? -1)) throw new VariableUnavailable('unsupported_encoding');
        const data = await this.raw(storage, size), unsigned = BigInt('0x' + Buffer.from(data).reverse().toString('hex'));
        result.hex = '0x' + unsigned.toString(16).padStart(size * 2, '0');
        result.value = node.kind === 'pointer' ? result.hex : node.encoding === 4
          ? String(size === 4 ? data.readFloatLE() : size === 8 ? data.readDoubleLE() : (() => { throw new VariableUnavailable('unsupported_float'); })())
          : node.encoding === 2 ? String(unsigned !== 0n) : String([5, 6].includes(node.encoding ?? -1) ? BigInt.asIntN(size * 8, unsigned) : unsigned);
        if (node.kind === 'pointer' && this.options.follow_pointers) {
          if (!unsigned) result.children = [{ name: '*', status: 'null_pointer' }];
          else if (depth >= this.options.max_depth || this.nodes >= this.options.max_nodes) result.truncated = true;
          else result.children = [await this.render('*', node.target ?? null, { kind: 'address', value: unsigned }, depth + 1)];
        }
      } else if (node.kind === 'struct' || node.kind === 'array') {
        if (depth >= this.options.max_depth) { result.truncated = true; result.status = 'partial'; return result; }
        if (storage.kind !== 'address' && size > 16) throw new VariableUnavailable('unsupported_register_aggregate');
        result.children = [];
        if (node.kind === 'array') {
          if (node.count === null || node.count === undefined) throw new VariableUnavailable('unsupported_array_bounds');
          const stride = this.size(node.target ?? null);
          if (!stride && node.count) throw new VariableUnavailable('unknown_array_stride');
          if (node.count * stride !== size) throw new VariableUnavailable('unsupported_array_layout');
          for (let i = 0; i < Math.min(node.count, this.options.max_children) && this.nodes < this.options.max_nodes; i++)
            result.children.push(await this.render(`[${i}]`, node.target ?? null, this.offset(storage, i * stride), depth + 1));
          result.truncated = result.children.length < node.count;
        } else {
          for (const item of (node.members ?? []).slice(0, this.options.max_children)) {
            if (this.nodes >= this.options.max_nodes) break;
            if (item.status || item.offset === null) { this.nodes++; result.children.push({ name: item.name, status: item.status ?? 'unsupported_member_offset' }); continue; }
            let width: number;
            try { width = this.size(item.type); } catch (error) {
              if (!(error instanceof VariableUnavailable)) throw error;
              this.nodes++; result.children.push({ name: item.name, status: error.message }); continue;
            }
            if (item.offset + width > size) { this.nodes++; result.children.push({ name: item.name, status: 'invalid_member_extent' }); continue; }
            result.children.push(await this.render(item.name, item.type, this.offset(storage, item.offset), depth + 1));
          }
          result.truncated = node.truncated || result.children.length < (node.members?.length ?? 0);
        }
      } else throw new VariableUnavailable('unsupported_type');
      if (result.truncated || result.children?.some(child => child.status !== 'available')) result.status = 'partial';
    } catch (error) {
      if (!(error instanceof VariableUnavailable)) throw error;
      result.status = error.message;
    }
    return result;
  }
}
