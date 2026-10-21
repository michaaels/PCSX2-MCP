"""Bounded current-physical-frame DWARF metadata. No runtime reads or expression execution."""
import hashlib
import json
import os
import sys


class Metadata:
    def __init__(self, dwarf, pc):
        self.dwarf, self.pc = dwarf, pc
        self.types = {}

    def attr(self, die, name, depth=0):
        if depth > 8:
            raise ValueError('Excessive abstract-origin/specification chain')
        if name in die.attributes:
            return die.attributes[name]
        for link in ('DW_AT_abstract_origin', 'DW_AT_specification'):
            if link in die.attributes:
                return self.attr(die.get_DIE_from_attribute(link), name, depth + 1)
        return None

    def name(self, die):
        attr = self.attr(die, 'DW_AT_name')
        value = attr.value.decode('utf-8', errors='strict') if attr else '<anonymous>'
        if len(value) > 1024:
            raise ValueError('DWARF name exceeds 1024 characters')
        return value

    def ranges(self, die):
        from elftools.dwarf.descriptions import describe_form_class
        attrs = die.attributes
        low, high = attrs.get('DW_AT_low_pc'), attrs.get('DW_AT_high_pc')
        if low and high:
            form_class = describe_form_class(high.form)
            if form_class not in ('address', 'constant'):
                raise ValueError('Unsupported high_pc form')
            end = high.value if form_class == 'address' else low.value + high.value
            return [(low.value, end)]
        attr = attrs.get('DW_AT_ranges')
        if attr:
            top = die.cu.get_top_DIE().attributes.get('DW_AT_low_pc')
            base = top.value if top else 0
            result = []
            for index, entry in enumerate(self.dwarf.range_lists().get_range_list_at_offset(attr.value, die.cu)):
                if index >= 4096:
                    raise ValueError('Too many DWARF ranges')
                if hasattr(entry, 'base_address'):
                    base = entry.base_address
                else:
                    offset = 0 if entry.is_absolute else base
                    result.append((offset + entry.begin_offset, offset + entry.end_offset))
            return result
        return []

    def contains(self, die):
        return any(0 <= start <= self.pc < end <= 0x100000000 for start, end in self.ranges(die))

    def ops(self, die, expression):
        from elftools.dwarf.dwarf_expr import DWARFExprParser
        if len(expression) > 512:
            return {'status': 'unsupported_expression', 'detail': 'expression_too_large'}
        try:
            ops = DWARFExprParser(die.cu.structs).parse_expr(expression)
            if len(ops) > 64:
                return {'status': 'unsupported_expression', 'detail': 'too_many_operations'}
            result = []
            for op in ops:
                name, args = op.op_name, op.args
                if name == 'DW_OP_addrx':
                    name, args = 'DW_OP_addr', [self.dwarf.get_addr(die.cu, args[0])]
                if not all(isinstance(arg, int) for arg in args):
                    return {'status': 'unsupported_expression', 'detail': name}
                result.append({'op': name, 'args': [str(arg) for arg in args]})
            return {'status': 'expression', 'ops': result} if result else {'status': 'location_unavailable'}
        except Exception as error:
            return {'status': 'unsupported_expression', 'detail': type(error).__name__}

    def location(self, die, name='DW_AT_location'):
        from elftools.dwarf.locationlists import LocationParser
        if name == 'DW_AT_location' and 'DW_AT_start_scope' in die.attributes:
            return {'status': 'unsupported_start_scope'}
        if 'DW_AT_GNU_locviews' in die.attributes:
            return {'status': 'unsupported_location_views'}
        attr = die.attributes.get(name)  # Never inherit an abstract inline location.
        if attr is None:
            constant = self.attr(die, 'DW_AT_const_value') if name == 'DW_AT_location' else None
            if constant and isinstance(constant.value, int):
                return {'status': 'constant', 'value': str(constant.value)}
            return {'status': 'location_unavailable'}
        try:
            parsed = LocationParser(self.dwarf.location_lists()).parse_from_attribute(attr, die.cu.header.version, die=die)
            if hasattr(parsed, 'loc_expr'):
                return self.ops(die, parsed.loc_expr)
            if len(parsed) > 4096:
                return {'status': 'unsupported_location_list', 'detail': 'entry_limit'}
            base_attr = die.cu.get_top_DIE().attributes.get('DW_AT_low_pc')
            base = base_attr.value if base_attr else 0
            matches, default = [], None
            for entry in parsed:
                if hasattr(entry, 'base_address'):
                    base = entry.base_address
                elif hasattr(entry, 'loc_expr'):
                    if entry.begin_offset == entry.end_offset == -1:
                        default = entry.loc_expr
                    else:
                        offset = 0 if entry.is_absolute else base
                        if offset + entry.begin_offset <= self.pc < offset + entry.end_offset:
                            matches.append((entry.loc_expr, [offset + entry.begin_offset, offset + entry.end_offset]))
            if len(matches) > 1:
                return {'status': 'ambiguous_location'}
            expr = matches[0][0] if matches else default
            if expr is None:
                return {'status': 'not_live_at_pc'}
            result = self.ops(die, expr)
            if matches:
                result['valid_range'] = matches[0][1]
            else:
                result['default_location'] = True
            return result
        except Exception as error:
            return {'status': 'unsupported_location_list', 'detail': type(error).__name__}

    def type_ref(self, die, depth=0):
        # Names/types may be inherited; locations and lifetimes may not.
        owner = die
        for _ in range(9):
            if 'DW_AT_type' in owner.attributes:
                return self.type_node(owner.get_DIE_from_attribute('DW_AT_type'), depth)
            link = next((key for key in ('DW_AT_abstract_origin', 'DW_AT_specification') if key in owner.attributes), None)
            if not link:
                return None
            owner = owner.get_DIE_from_attribute(link)
        return None

    def type_node(self, die, depth):
        from elftools.dwarf.descriptions import describe_form_class
        key = str(die.offset)
        if key in self.types:
            return key
        if len(self.types) >= 256 or depth > 16:
            raise ValueError('DWARF type graph exceeds limits')
        node = {'name': self.name(die), 'kind': 'unsupported', 'size': None}
        self.types[key] = node
        attrs, tag = die.attributes, die.tag
        size = attrs.get('DW_AT_byte_size')
        constant = lambda attr: attr is not None and describe_form_class(attr.form) == 'constant' and isinstance(attr.value, int)
        if constant(size) and 0 <= size.value <= 0x100000000:
            node['size'] = size.value
        if tag == 'DW_TAG_base_type':
            node.update(kind='base', encoding=attrs.get('DW_AT_encoding').value if attrs.get('DW_AT_encoding') else None)
        elif tag == 'DW_TAG_pointer_type':
            node.update(kind='pointer', target=self.type_ref(die, depth + 1), size=node['size'] or die.cu['address_size'])
        elif tag in ('DW_TAG_const_type', 'DW_TAG_volatile_type', 'DW_TAG_restrict_type', 'DW_TAG_typedef'):
            node.update(kind='alias', target=self.type_ref(die, depth + 1))
        elif tag == 'DW_TAG_structure_type':
            members = []
            node.update(kind='struct', members=members, truncated=False)
            for child in die.iter_children():
                if child.tag != 'DW_TAG_member':
                    if child.tag == 'DW_TAG_inheritance':
                        node['truncated'] = True
                    continue
                if len(members) >= 32:
                    node['truncated'] = True
                    break
                member = {'name': self.name(child), 'type': self.type_ref(child, depth + 1), 'offset': None}
                offset = child.attributes.get('DW_AT_data_member_location')
                if any(key in child.attributes for key in ('DW_AT_bit_size', 'DW_AT_bit_offset', 'DW_AT_data_bit_offset')):
                    member['status'] = 'unsupported_bitfield'
                elif constant(offset) and die.cu.header.version >= 3:
                    member['offset'] = offset.value
                elif offset and isinstance(offset.value, (list, bytes)):
                    ops = self.ops(child, offset.value)
                    if ops.get('ops') and len(ops['ops']) == 1 and ops['ops'][0]['op'] == 'DW_OP_plus_uconst':
                        member['offset'] = int(ops['ops'][0]['args'][0])
                members.append(member)
        elif tag == 'DW_TAG_array_type':
            if 'DW_AT_data_location' in attrs:
                node['detail'] = 'DW_AT_data_location'
                return key
            bounds = [child for child in die.iter_children() if child.tag == 'DW_TAG_subrange_type']
            node.update(kind='array', target=self.type_ref(die, depth + 1), count=None)
            if len(bounds) == 1 and not any(key in attrs for key in ('DW_AT_byte_stride', 'DW_AT_bit_stride')):
                b = bounds[0].attributes
                low, count, high = b.get('DW_AT_lower_bound'), b.get('DW_AT_count'), b.get('DW_AT_upper_bound')
                if (not low or (constant(low) and low.value == 0)) and not any(key in b for key in ('DW_AT_byte_stride', 'DW_AT_bit_stride')):
                    value = count.value if constant(count) else high.value + 1 if not count and constant(high) else None
                    if isinstance(value, int) and 0 <= value <= 0x100000000:
                        node['count'] = value
        else:
            node['detail'] = tag
        return key

    def frame_cfa(self):
        from elftools.dwarf.callframe import FDE
        try:
            if not self.dwarf.has_CFI():
                return {'status': 'cfa_unavailable'}
            matches = []
            for index, entry in enumerate(self.dwarf.CFI_entries()):
                if index > 32768:
                    return {'status': 'cfa_unavailable'}
                if isinstance(entry, FDE) and entry['initial_location'] <= self.pc < entry['initial_location'] + entry['address_range']:
                    rows = [row for row in entry.get_decoded().table if row['pc'] <= self.pc]
                    if rows:
                        matches.append(rows[-1]['cfa'])
            if len(matches) == 1 and matches[0].expr is None and matches[0].reg is not None:
                return {'status': 'register_offset', 'register': matches[0].reg, 'offset': str(matches[0].offset)}
        except Exception:
            pass
        return {'status': 'cfa_unavailable'}

    def frame(self, function):
        variables, inline, scopes = [], [], []
        def visit(scope, depth):
            if depth > 32:
                raise ValueError('Scope depth exceeds limit')
            scope_id = str(scope.offset)
            scopes.append({'id': scope_id, 'tag': scope.tag, 'depth': depth})
            for child in scope.iter_children():
                if child.tag in ('DW_TAG_formal_parameter', 'DW_TAG_variable'):
                    if len(variables) >= 256:
                        raise ValueError('Frame has more than 256 variables')
                    variables.append({'id': str(child.offset), 'name': self.name(child), 'scope': scope_id,
                        'kind': 'argument' if child.tag == 'DW_TAG_formal_parameter' else 'local',
                        'type': self.type_ref(child), 'location': self.location(child)})
                elif child.tag == 'DW_TAG_lexical_block' and self.contains(child):
                    visit(child, depth + 1)
                elif child.tag == 'DW_TAG_inlined_subroutine' and self.contains(child):
                    inline.append({'id': str(child.offset), 'name': self.name(child), 'status': 'unsupported_inline_scope'})
        visit(function, 0)
        # Treat known prologues/epilogues conservatively. Legacy producers without
        # markers still rely on their declared location validity beyond the entry.
        function_ranges = self.ranges(function)
        program = self.dwarf.line_program_for_CU(function.cu)
        source_line, prologue, epilogue = None, [], []
        if program:
            previous = None
            for index, entry in enumerate(program.get_entries()):
                if index > 2000000:
                    raise ValueError('Line table limit exceeded')
                state = entry.state
                if state is None:
                    continue
                if previous and previous.address <= self.pc < state.address:
                    source_line = previous.line
                if state.end_sequence:
                    previous = None
                    continue
                if any(start <= state.address < end for start, end in function_ranges):
                    if state.prologue_end: prologue.append(state.address)
                    if state.epilogue_begin: epilogue.append(state.address)
                previous = state
        starts = [start for start, _ in function_ranges]
        decl = self.attr(function, 'DW_AT_decl_line')
        guard = 'compiler_reported'
        if self.pc == min(starts) or (prologue and self.pc < min(prologue)) or (not prologue and decl and source_line == decl.value):
            guard = 'prologue'
        elif epilogue and self.pc >= min(epilogue):
            guard = 'epilogue'
        return {'function': self.name(function), 'id': str(function.offset), 'ranges': function_ranges,
            'source_line': source_line, 'location_guard': guard, 'has_prologue_marker': bool(prologue),
            'frame_base': self.location(function, 'DW_AT_frame_base'), 'cfa': self.frame_cfa(),
            'scopes': scopes, 'inline_scopes': inline, 'variables': variables, 'types': self.types}


def read_variables(filename, pc):
    import elftools
    from elftools.elf.elffile import ELFFile
    if elftools.__version__ != '0.33':
        raise ValueError('Expected pinned pyelftools 0.33')
    with open(filename, 'rb') as stream:
        stat = os.fstat(stream.fileno())
        if not 52 <= stat.st_size <= 256 * 1024 * 1024:
            raise ValueError('ELF size exceeds limits')
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        stream.seek(0)
        elf = ELFFile(stream)
        if elf.elfclass != 32 or not elf.little_endian or elf['e_machine'] != 'EM_MIPS' or elf['e_type'] != 'ET_EXEC':
            raise ValueError('Expected linked ELF32 little-endian MIPS')
        for section in elf.iter_sections():
            if section.name.startswith('.zdebug') or section['sh_flags'] & 0x800 or (section.name.startswith('.debug') and section['sh_size'] > 32 * 1024 * 1024):
                raise ValueError('Compressed/excessive debug section unsupported')
        if not elf.has_dwarf_info(strict=True):
            raise ValueError('Embedded DWARF required')
        dwarf = elf.get_dwarf_info(relocate_dwarf_sections=False, follow_links=False)
        metadata, functions, count = Metadata(dwarf, pc), [], 0
        for index, cu in enumerate(dwarf.iter_CUs()):
            if index >= 4096 or cu.header.version not in (2, 3, 4, 5):
                raise ValueError('Unsupported/excessive compilation units')
            top = cu.get_top_DIE()
            if metadata.ranges(top) and not metadata.contains(top):
                continue
            for die in cu.iter_DIEs():
                count += 1
                if count > 2000000:
                    raise ValueError('DIE limit exceeded')
                if die.tag == 'DW_TAG_subprogram' and metadata.contains(die):
                    functions.append(die)
        if len(functions) != 1:
            raise ValueError('Current PC has missing/ambiguous physical function ranges')
        result = metadata.frame(functions[0])
        after = os.fstat(stream.fileno())
        if (stat.st_size, stat.st_mtime_ns, stat.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
            raise ValueError('ELF changed during metadata lookup')
        return {'format_version': 1, 'sha256': digest, 'pc': f'0x{pc:08x}', 'dwarf_version': functions[0].cu.header.version, **result}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3 or not 0 <= int(sys.argv[2], 16) <= 0xffffffff:
            raise ValueError('Usage: dwarf_variables.py <ELF> <hex PC>')
        result = json.dumps(read_variables(sys.argv[1], int(sys.argv[2], 16)), ensure_ascii=True)
        if len(result) > 1024 * 1024:
            raise ValueError('Metadata output exceeds 1 MiB')
        print(result)
    except Exception as error:
        print(f'DWARF variables: {type(error).__name__}: {error}', file=sys.stderr)
        raise SystemExit(1)
