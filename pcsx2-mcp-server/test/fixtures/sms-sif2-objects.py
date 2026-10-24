"""Fixture-only SIF2 semaphore and EE syscall symbol identity."""
from pathlib import Path
import importlib.util
import io
import json
import sys

spec = importlib.util.spec_from_file_location('sms_objects', Path(__file__).with_name('sms-incident-objects.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

if __name__ == '__main__':
    try:
        file = Path(sys.argv[1])
        result = helper.inspect(file, sys.argv[2], unit_name='SMS_SPU.c', names={'s_SemaPCM': 4})
        from elftools.elf.elffile import ELFFile
        elf = ELFFile(io.BytesIO(file.read_bytes()))
        symbols = elf.get_section_by_name('.symtab').get_symbol_by_name('WaitSema') or []
        if len(symbols) != 1 or not 0 <= symbols[0]['st_value'] < 0x02000000:
            raise ValueError('WaitSema symbol')
        result['wait_sema_address'] = f"0x{symbols[0]['st_value']:08x}"
        print(json.dumps(result))
    except Exception:
        print(json.dumps({'error': 'SMS SIF2 fixture metadata unavailable or unsupported'}))
        sys.exit(1)
