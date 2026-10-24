#!/usr/bin/env python3
"""Build known EE/IOP instruction and non-returning-call vectors, without SMS."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output',type=Path,help='New directory')
    args=parser.parse_args();output=args.output.resolve()
    if output.exists():parser.error('Output exists; choose a new directory')
    repo=Path(__file__).resolve().parent.parent
    spec=importlib.util.spec_from_file_location('sdk',repo/'tools/build-iop-exception-fixture.py')
    sdk=importlib.util.module_from_spec(spec);spec.loader.exec_module(sdk)
    shutil.copytree(repo/'pcsx2-mcp-server/test/fixtures/instruction-control',output)
    subprocess.run(['docker','run','--rm','--mount',f'type=bind,source={output},target=/fixture',
                    '-w','/fixture',sdk.IMAGE,'sh','/fixture/build.sh'],check=True)
    sdk.restore_iop_program_headers(output,'instruction-control')
    names=['instruction-control.elf','instruction-control.irx','instruction-control.debug.irx','toolchain.txt',
           'ee-instructions.c','iop-instructions.c','instructions.S','Makefile.ee','Makefile.iop','build.sh']
    data={'kind':'standalone_instruction_fixture','image':sdk.IMAGE,
          'sha256':{n:hashlib.sha256((output/n).read_bytes()).hexdigest() for n in names}}
    (output/'manifest.json').write_text(json.dumps(data,indent=2)+'\n',encoding='utf-8')
    print(output/'manifest.json')

if __name__=='__main__':main()
