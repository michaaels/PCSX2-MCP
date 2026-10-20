"""Read bounded DWARF line-table locations. No source/supplementary files or VM access."""
import hashlib
import json
import ntpath
import os
import posixpath
import sys


def source_path(program, index, comp_dir):
    version = program.header.version
    entries = program.header.file_entry
    offset = index if version >= 5 else index - 1
    if not 0 <= offset < len(entries):
        raise ValueError('Invalid DWARF file index')
    entry = entries[offset]
    decode = lambda value: value.decode('utf-8', errors='strict') if isinstance(value, bytes) else str(value)
    name = decode(entry.name)
    directory = comp_dir
    if version >= 5:
        directories = program.header.include_directory
        if entry.dir_index is not None:
            if not 0 <= entry.dir_index < len(directories):
                raise ValueError('Invalid DWARF directory index')
            directory = decode(directories[entry.dir_index])
    elif entry.dir_index:
        directories = program.header.include_directory
        if not 1 <= entry.dir_index <= len(directories):
            raise ValueError('Invalid DWARF directory index')
        directory = decode(directories[entry.dir_index - 1])
    absolute = lambda value: value.startswith('/') or ntpath.isabs(value)
    if not absolute(directory):
        directory = posixpath.join(comp_dir, directory)
    result = name if absolute(name) else posixpath.join(directory, name)
    return posixpath.normpath(result.replace('\\', '/'))


def read_locations(filename, requested_line):
    import elftools
    from elftools.elf.elffile import ELFFile
    if elftools.__version__ != '0.33':
        raise ValueError('Expected pyelftools 0.33; install requirements-dwarf.txt')
    with open(filename, 'rb') as stream:
        stat = os.fstat(stream.fileno())
        if not 52 <= stat.st_size <= 256 * 1024 * 1024:
            raise ValueError('ELF must be 52 bytes to 256 MiB')
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        stream.seek(0)
        elf = ELFFile(stream)
        if elf.elfclass != 32 or not elf.little_endian or elf['e_machine'] != 'EM_MIPS' or elf['e_type'] != 'ET_EXEC':
            raise ValueError('Expected linked ELF32 little-endian MIPS')
        for section in elf.iter_sections():
            if section.name.startswith('.zdebug') or (section['sh_flags'] & 0x800):
                raise ValueError('Compressed debug sections are not supported by line lookup')
            if section.name.startswith('.debug') and section['sh_size'] > 32 * 1024 * 1024:
                raise ValueError('Debug section exceeds 32 MiB')
        if not elf.has_dwarf_info(strict=True):
            raise ValueError('ELF has no embedded DWARF information')
        dwarf = elf.get_dwarf_info(relocate_dwarf_sections=False, follow_links=False)
        files, locations, versions = set(), set(), set()
        rows = 0
        for cu_index, cu in enumerate(dwarf.iter_CUs()):
            if cu_index >= 4096 or cu.header.version not in (2, 3, 4, 5):
                raise ValueError('Unsupported/excessive DWARF compilation units')
            versions.add(cu.header.version)
            program = dwarf.line_program_for_CU(cu)
            if program is None:
                continue
            comp = cu.get_top_DIE().attributes.get('DW_AT_comp_dir')
            comp_dir = comp.value.decode('utf-8', errors='strict') if comp else ''
            for index in range(len(program.header.file_entry)):
                files.add(source_path(program, index if program.header.version >= 5 else index + 1, comp_dir))
            previous = None
            for entry in program.get_entries():
                rows += 1
                if rows > 2000000 or len(files) > 4096:
                    raise ValueError('DWARF line table exceeds lookup limits')
                state = entry.state
                if state is None:
                    continue
                if previous is not None:
                    prior, prior_file = previous
                    # A row has instructions only until the next address in its sequence.
                    if state.address > prior.address and prior.line == requested_line and prior.is_stmt and 0 <= prior.address <= 0xffffffff:
                        locations.add((prior_file, prior.address, prior.column, prior.discriminator))
                        if len(locations) > 4096:
                            raise ValueError('Too many locations at this source line')
                if state.end_sequence:
                    previous = None
                    continue
                filename_at_row = source_path(program, state.file, comp_dir)
                files.add(filename_at_row)
                previous = (state, filename_at_row)
        after = os.fstat(stream.fileno())
        if (stat.st_size, stat.st_mtime_ns, stat.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
            raise ValueError('ELF changed while reading DWARF')
        return {'format_version': 1, 'sha256': digest, 'dwarf_versions': sorted(versions), 'files': sorted(files),
                'locations': [{'file': file, 'address': f'0x{address:08x}', 'line': requested_line,
                               'column': column, 'discriminator': discriminator}
                              for file, address, column, discriminator in sorted(locations)]}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3 or not 1 <= int(sys.argv[2]) <= 2147483647:
            raise ValueError('Usage: dwarf_lines.py <ELF> <line 1..2147483647>')
        result = json.dumps(read_locations(sys.argv[1], int(sys.argv[2])), ensure_ascii=True)
        if len(result) > 1024 * 1024:
            raise ValueError('DWARF lookup output exceeds 1 MiB')
        print(result)
    except Exception as error:
        print(f'DWARF line lookup: {type(error).__name__}: {error}', file=sys.stderr)
        raise SystemExit(1)
