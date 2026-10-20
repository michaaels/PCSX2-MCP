#!/usr/bin/env python3
"""Restore a test ELF's global symbols from its matching GNU link map and .o files.

Metadata only: verifies every PT_LOAD byte is unchanged. Inputs must come from the
same build; this cannot establish that an arbitrary map belongs to an ELF.
"""
import argparse
from pathlib import Path
import re
import struct


def sections(data):
    offset = struct.unpack_from('<I', data, 32)[0]
    stride, count = struct.unpack_from('<HH', data, 46)
    if stride != 40:
        raise ValueError('Expected ELF32 section headers')
    return [list(struct.unpack_from('<10I', data, offset + i * stride)) for i in range(count)]


def symbols(data):
    table = sections(data)
    for section in table:
        if section[1] != 2:
            continue
        strings = table[section[6]]
        names = data[strings[4]:strings[4] + strings[5]]
        for offset in range(section[4], section[4] + section[5], section[9]):
            name, _, size, info, _, index = struct.unpack_from('<IIIBBH', data, offset)
            if index and info >> 4 in (1, 2) and info & 15 in (1, 2):
                yield names[name:].split(b'\0', 1)[0].decode('utf-8'), size, info & 15


def load_segments(data):
    offset = struct.unpack_from('<I', data, 28)[0]
    stride, count = struct.unpack_from('<HH', data, 42)
    result = []
    for i in range(count):
        header = struct.unpack_from('<8I', data, offset + i * stride)
        if header[0] == 1:
            result.append((header, data[header[1]:header[1] + header[4]]))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('elf', type=Path)
    parser.add_argument('map', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('objects', nargs='+', type=Path)
    args = parser.parse_args()
    original = args.elf.read_bytes()
    if original[:6] != b'\x7fELF\x01\x01' or struct.unpack_from('<H', original, 18)[0] != 8:
        raise ValueError('Expected ELF32 little-endian MIPS')
    mapped = {}
    for line in args.map.read_text(encoding='utf-8').splitlines():
        match = re.fullmatch(r'\s*0x([0-9a-fA-F]+)\s+(\S+)\s*', line)
        if match:
            address, name = int(match[1], 16), match[2]
            if name in mapped and mapped[name] != address:
                raise ValueError(f'Ambiguous map name: {name}')
            mapped[name] = address
    entry = struct.unpack_from('<I', original, 24)[0]
    if mapped.get('_start') != entry:
        raise ValueError('The map entry point does not match this ELF')
    records = {'_start': (4, 2)}
    for obj in args.objects:
        records.update({name: (size, kind) for name, size, kind in symbols(obj.read_bytes()) if name in mapped})
    table = sections(original)
    if any(row[1] == 2 for row in table):
        raise ValueError('Input already contains a symbol table')
    shstr_index = struct.unpack_from('<H', original, 50)[0]
    shstr = table[shstr_index]
    section_names = bytearray(original[shstr[4]:shstr[4] + shstr[5]])
    str_name = len(section_names); section_names += b'.strtab\0'
    sym_name = len(section_names); section_names += b'.symtab\0'
    names = bytearray(b'\0'); symtab = bytearray(16)
    for name, (size, kind) in records.items():
        address = mapped[name]
        index = next((i for i, row in enumerate(table) if row[2] & 2 and row[3] <= address < row[3] + row[5]), None)
        if index is None:
            continue
        name_offset = len(names); names += name.encode('utf-8') + b'\0'
        symtab += struct.pack('<IIIBBH', name_offset, address, size, 0x10 | kind, 0, index)
    result = bytearray(original)
    strings_offset = len(result); result += names
    result += bytes(-len(result) % 4)
    symbols_offset = len(result); result += symtab
    shstr[4] = len(result); shstr[5] = len(section_names); result += section_names
    result += bytes(-len(result) % 4)
    header_offset = len(result)
    table.extend([
        [str_name, 3, 0, 0, strings_offset, len(names), 0, 0, 1, 0],
        [sym_name, 2, 0, 0, symbols_offset, len(symtab), len(table), 1, 4, 16],
    ])
    for row in table:
        result += struct.pack('<10I', *row)
    struct.pack_into('<I', result, 32, header_offset)
    struct.pack_into('<H', result, 48, len(table))
    if load_segments(result) != load_segments(original):
        raise ValueError('Refusing to write: loadable segments changed')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('xb') as output:
        output.write(result)
    print(f'Wrote {len(symtab) // 16 - 1} symbols; every PT_LOAD byte is unchanged: {args.output}')


if __name__ == '__main__':
    main()
