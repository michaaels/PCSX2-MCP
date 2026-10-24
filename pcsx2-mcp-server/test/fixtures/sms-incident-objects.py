"""Fixture-only, bounded DWARF addresses for two SMS updater statics. No VM IO."""
import hashlib
import io
import json
from pathlib import Path
import sys


def type_size(die, depth=0):
    if depth > 8:
        raise ValueError('Type depth')
    if die.tag in ('DW_TAG_const_type', 'DW_TAG_volatile_type', 'DW_TAG_typedef'):
        return type_size(die.get_DIE_from_attribute('DW_AT_type'), depth + 1)
    if die.tag == 'DW_TAG_base_type':
        size = die.attributes['DW_AT_byte_size'].value
        if not isinstance(size, int) or not 1 <= size <= 8:
            raise ValueError('Base size')
        return size
    if die.tag == 'DW_TAG_array_type':
        element = type_size(die.get_DIE_from_attribute('DW_AT_type'), depth + 1)
        dimensions = list(die.iter_children())
        if not 1 <= len(dimensions) <= 2 or any(d.tag != 'DW_TAG_subrange_type' for d in dimensions):
            raise ValueError('Array dimensions')
        for dimension in dimensions:
            bounds = dimension.attributes
            low = bounds.get('DW_AT_lower_bound')
            if low is not None and low.value != 0:
                raise ValueError('Array lower bound')
            upper = bounds['DW_AT_upper_bound'].value
            if not isinstance(upper, int) or not 0 <= upper < 4096:
                raise ValueError('Array upper bound')
            element *= upper + 1
        if element > 8192:
            raise ValueError('Array size limit')
        return element
    raise ValueError('Unsupported fixture type')


def inspect(file, expected, *, unit_name='SMS_JellyfinUpdate.c', names=None):
    from elftools.elf.elffile import ELFFile
    from elftools.dwarf.descriptions import describe_form_class
    if file.stat().st_size > 256 * 1024 * 1024:
        raise ValueError('ELF size limit')
    data = file.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected:
        raise ValueError('ELF hash mismatch')
    elf = ELFFile(io.BytesIO(data))
    if elf.elfclass != 32 or not elf.little_endian or elf['e_machine'] != 'EM_MIPS' or elf['e_type'] != 'ET_EXEC':
        raise ValueError('ELF format')
    if elf.num_sections() > 4096:
        raise ValueError('Section count')
    if any(section['sh_size'] > 32 * 1024 * 1024 for section in elf.iter_sections()
           if section.name.startswith('.debug')):
        raise ValueError('Debug section limit')
    dwarf = elf.get_dwarf_info()
    names = names or {'s_UpdateDir': 128, 's_UpdatesDisabled': 4}
    found = {name: [] for name in names}
    dies = 0
    for index, cu in enumerate(dwarf.iter_CUs()):
        if index >= 4096:
            raise ValueError('CU count')
        top = cu.get_top_DIE()
        attr = top.attributes.get('DW_AT_name')
        unit = attr.value.decode('utf-8') if attr else ''
        if len(unit) > 1024:
            raise ValueError('CU name')
        if unit.replace('\\', '/').split('/')[-1] != unit_name:
            continue
        for die in cu.iter_DIEs():
            dies += 1
            if dies > 2000000:
                raise ValueError('DIE count')
            attr = die.attributes.get('DW_AT_name')
            if die.tag != 'DW_TAG_variable' or attr is None:
                continue
            name = attr.value.decode('utf-8')
            if name not in names or 'DW_AT_declaration' in die.attributes:
                continue
            # Only direct CU statics, direct DW_OP_addr and fixed proven sizes.
            if die.get_parent() != top:
                raise ValueError('Variable scope')
            location = die.attributes['DW_AT_location']
            if describe_form_class(location.form) not in ('block', 'exprloc'):
                raise ValueError('Variable location form')
            expression = bytes(location.value)
            if len(expression) != 5 or expression[0] != 3 or cu['address_size'] != 4:
                raise ValueError('Variable location expression')
            address = int.from_bytes(expression[1:], 'little')
            size = type_size(die.get_DIE_from_attribute('DW_AT_type'))
            if size != names[name] or not 0 <= address < address + size <= 0x02000000:
                raise ValueError('Object size/range')
            writable = [segment for segment in elf.iter_segments() if segment['p_type'] == 'PT_LOAD'
                        and segment['p_flags'] & 2 and segment['p_vaddr'] <= address
                        and address + size <= segment['p_vaddr'] + segment['p_memsz']]
            if len(writable) != 1:
                raise ValueError('Writable object segment')
            found[name].append(dict(name=name, address=f'0x{address:08x}', size=size,
                source_file=unit, die_offset=die.offset, location_hex=expression.hex(),
                origin='hash_checked_DWARF_CU_static_DW_OP_addr_and_fixed_type'))
    result = []
    symtab = elf.get_section_by_name('.symtab')
    if symtab is None or symtab.num_symbols() > 1000000:
        raise ValueError('Symbol table unavailable/oversized')
    for name, matches in found.items():
        if len(matches) != 1:
            raise ValueError('Missing/ambiguous DWARF object')
        item = matches[0]
        symbols = symtab.get_symbol_by_name(name) or []
        if len(symbols) != 1 or symbols[0]['st_value'] != int(item['address'], 16):
            raise ValueError('DWARF/symbol address mismatch')
        # Legacy GCC emits NOTYPE with size zero; preserve that limitation.
        item['symtab_type'] = symbols[0]['st_info']['type']
        item['symtab_size'] = symbols[0]['st_size']
        result.append(item)
    return dict(format_version=1, elf_sha256=digest, objects=result)


if __name__ == '__main__':
    try:
        print(json.dumps(inspect(Path(sys.argv[1]), sys.argv[2])))
    except Exception:
        print(json.dumps({'error': 'SMS incident object metadata unavailable or unsupported'}))
        sys.exit(1)
