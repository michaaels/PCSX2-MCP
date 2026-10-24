"""Read-only fixture metadata for selected SMS_Player members; no VM operations."""
from pathlib import Path
import hashlib
import io
import json
import sys


def inspect(file, expected):
    from elftools.elf.elffile import ELFFile
    from elftools.dwarf.descriptions import describe_form_class
    if not 0 < file.stat().st_size <= 256 * 1024 * 1024:
        raise ValueError('ELF size')
    data = file.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError('ELF SHA')
    elf = ELFFile(io.BytesIO(data))
    if elf.elfclass != 32 or not elf.little_endian or elf['e_machine'] != 'EM_MIPS' or elf['e_type'] != 'ET_EXEC':
        raise ValueError('ELF format')
    if elf.num_sections() > 4096 or any(s['sh_size'] > 32*1024*1024 for s in elf.iter_sections() if s.name.startswith('.debug')):
        raise ValueError('ELF sections')
    def unwrap(die):
        for _ in range(8):
            if die.tag not in ('DW_TAG_typedef', 'DW_TAG_const_type', 'DW_TAG_volatile_type'):
                return die
            die = die.get_DIE_from_attribute('DW_AT_type')
        raise ValueError('Type depth')
    matches = []
    for index, cu in enumerate(elf.get_dwarf_info().iter_CUs()):
        if index >= 4096:
            raise ValueError('CU count')
        top = cu.get_top_DIE()
        attr = top.attributes.get('DW_AT_name')
        if not attr or attr.value.decode('utf8').replace('\\', '/').split('/')[-1] != 'SMS_Player.c':
            continue
        for child in top.iter_children():
            name = child.attributes.get('DW_AT_name')
            if child.tag == 'DW_TAG_variable' and name and name.value == b's_Player' and 'DW_AT_declaration' not in child.attributes:
                matches.append((child, cu))
    if len(matches) != 1:
        raise ValueError('Missing/ambiguous player')
    variable, cu = matches[0]
    expression = variable.attributes['DW_AT_location']
    if describe_form_class(expression.form) not in ('block', 'exprloc') or len(expression.value) != 5 or expression.value[0] != 3 or cu['address_size'] != 4:
        raise ValueError('Location')
    address = int.from_bytes(bytes(expression.value)[1:], 'little')
    structure = unwrap(variable.get_DIE_from_attribute('DW_AT_type'))
    size = structure.attributes['DW_AT_byte_size'].value
    if structure.tag != 'DW_TAG_structure_type' or not 0 < size <= 4096 or not 0 <= address < address+size <= 0x02000000:
        raise ValueError('Structure/range')
    symtab = elf.get_section_by_name('.symtab')
    if symtab is None or symtab.num_symbols() > 1000000:
        raise ValueError('Symbols')
    symbols = symtab.get_symbol_by_name('s_Player') or []
    if len([s for s in symbols if s['st_value'] == address]) != 1:
        raise ValueError('Player symbol mismatch')
    if len([s for s in elf.iter_segments() if s['p_type'] == 'PT_LOAD' and s['p_flags'] & 2 and s['p_vaddr'] <= address and address+size <= s['p_vaddr']+s['p_memsz']]) != 1:
        raise ValueError('Writable segment')
    wanted = {'m_pFileCtx': 4, 'm_pSPUCtx': 4, 'm_pIPUCtx': 4, 'm_pAudioSamples': 4, 'm_Flags': 4,
              'm_VideoIdx': 4, 'm_AudioIdx': 4, 'm_VideoTime': 8, 'm_AudioTime': 8, 'm_EOF': 4,
              'm_AudioChannels': 4, 'm_AudioSampleRate': 4}
    fields = []
    for member in structure.iter_children():
        a = member.attributes.get('DW_AT_name')
        name = a.value.decode('utf8') if a else ''
        if member.tag != 'DW_TAG_member' or name not in wanted:
            continue
        if any(k in member.attributes for k in ('DW_AT_bit_size', 'DW_AT_bit_offset', 'DW_AT_data_bit_offset')):
            raise ValueError('Bitfield')
        loc = member.attributes['DW_AT_data_member_location']
        if describe_form_class(loc.form) == 'constant':
            offset = loc.value
        else:
            b = bytes(loc.value)
            # GCC 3.2 emits a single DW_OP_constu here; modern encodings may
            # use DW_OP_plus_uconst. Both yield this fixture's member offset.
            if not 2 <= len(b) <= 4 or b[0] not in (0x10, 0x23):
                raise ValueError('Member location: '+name+' '+b.hex())
            offset = 0
            for index, value in enumerate(b[1:]):
                offset |= (value & 127) << (7 * index)
                if bool(value & 128) != (index < len(b)-2):
                    raise ValueError('Member ULEB')
        kind = unwrap(member.get_DIE_from_attribute('DW_AT_type'))
        width = kind.attributes.get('DW_AT_byte_size')
        width = width.value if width else 4 if kind.tag == 'DW_TAG_pointer_type' else None
        if kind.tag not in ('DW_TAG_base_type', 'DW_TAG_pointer_type') or width != wanted[name] or not 0 <= offset < offset+width <= size:
            raise ValueError('Member type/extent')
        encoding = kind.attributes.get('DW_AT_encoding')
        fields.append(dict(name=name, offset=offset, size=width, signed=bool(encoding and encoding.value in (5, 6)), type=kind.tag))
    if len(fields) != len(wanted) or len({f['name'] for f in fields}) != len(wanted):
        raise ValueError('Fields')
    return dict(format_version=1, elf_sha256=expected, address=f'0x{address:08x}', size=size, fields=fields,
                origin='direct_CU_static_DWARF_structure_members_symtab_and_segment_verified')


if __name__ == '__main__':
    try:
        print(json.dumps(inspect(Path(sys.argv[1]), sys.argv[2])))
    except Exception:
        print(json.dumps({'error': 'SMS player-state metadata unavailable or unsupported'}))
        sys.exit(1)
