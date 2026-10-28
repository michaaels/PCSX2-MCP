#!/usr/bin/env python3
"""Validate MCP with isolated homebrew fixtures, without SMS or external services."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--emulator',required=True,type=Path)
    parser.add_argument('--data-directory',required=True,type=Path,help='Configured root with inis/PCSX2.ini and your own BIOS reference')
    parser.add_argument('--output',required=True,type=Path,help='New directory; artifacts are never overwritten')
    parser.add_argument('--render-fixture',type=Path,help='Existing build-standalone-fixture output; otherwise build it using Docker')
    parser.add_argument('--sif-fixture',type=Path,help='Existing build-sif-transfer-fixture output; otherwise build it using Docker')
    parser.add_argument('--instruction-fixture',type=Path,help='Existing build-instruction-fixture output; otherwise build it using Docker')
    args=parser.parse_args()
    repo=Path(__file__).resolve().parent.parent
    emulator=args.emulator.resolve();configured=args.data_directory.resolve();output=args.output.resolve()
    if output.exists():parser.error('Output already exists; choose a new directory')
    if not emulator.is_file() or not (configured/'inis/PCSX2.ini').is_file():
        parser.error('Missing emulator or configured inis/PCSX2.ini')
    output.mkdir(parents=True)
    report={'kind':'standalone_mcp_acceptance','created_at':datetime.now(timezone.utc).isoformat(),
            'native_sha256':sha(emulator),'SMS_or_Jellyfin_involved':False,
            'physical_validation':'not_performed','audio_acceptance':'not_tested','checks':[],'suites':[]}
    def run(name,command,cwd=repo,timeout=180):
        log=output/(name+'.log')
        with log.open('w',encoding='utf-8') as stream:
            completed=subprocess.run([str(x) for x in command],cwd=cwd,stdout=stream,stderr=subprocess.STDOUT,
                                     timeout=timeout,encoding='utf-8')
        entry={'name':name,'exit_code':completed.returncode,'log':str(log),'log_sha256':sha(log)}
        report['suites'].append(entry)
        if completed.returncode:raise RuntimeError(f'{name} failed; inspect {log}')
        print('PASS '+name,flush=True)
    try:
        # npm test includes the TypeScript build and the project-independent Node suite.
        npm=['cmd','/c','npm','test'] if os.name=='nt' else ['npm','test']
        run('node-tests',npm,repo/'pcsx2-mcp-server')
        render=args.render_fixture.resolve() if args.render_fixture else output/'render-fixture'
        sif=args.sif_fixture.resolve() if args.sif_fixture else output/'sif-fixture'
        instructions=args.instruction_fixture.resolve() if args.instruction_fixture else output/'instruction-fixture'
        if not args.render_fixture:run('build-render',[sys.executable,repo/'tools/build-standalone-fixture.py',render])
        if not args.sif_fixture:run('build-sif',[sys.executable,repo/'tools/build-sif-transfer-fixture.py',sif])
        if not args.instruction_fixture:run('build-instructions',[sys.executable,repo/'tools/build-instruction-fixture.py',instructions])
        # Check retained build inputs against this checkout as well as checking manifests in Node.
        for fixture,source in [(render,'standalone'),(sif,'sif-transfer'),(instructions,'instruction-control')]:
            manifest=json.loads((fixture/'manifest.json').read_text())
            for file in (repo/'pcsx2-mcp-server/test/fixtures'/source).iterdir():
                if file.is_file():assert sha(file)==manifest['sha256'][file.name],f'Stale fixture input {file.name}'
        scripts=[('standalone','standalone-live.mjs',render),('sif-transfer','sif-transfer-live.mjs',sif),
                 ('sif-guards','sif-live.mjs',render/'standalone.elf'),
                 ('instructions','instruction-live.mjs',instructions),
                 ('reconnect','reconnect-live.mjs',render),
                 ('state-load','state-load-live.mjs',render)]
        for name,script,fixture in scripts:
            target=output/name
            run(name,['node',repo/'pcsx2-mcp-server/test'/script,emulator,fixture,configured,target])
            validation=target/'validation.json';v=json.loads(validation.read_text())
            assert v['passed'],f'{name} did not accept validation'
            if 'cases' in v:assert all(c['owned_emulator_stopped'] for c in v['cases'])
            else:assert v['owned_emulator_stopped']
            report['suites'][-1].update(validation=str(validation),validation_sha256=sha(validation),checks=len(v['checks']))
            report['checks'].extend(f'{name}: {c}' for c in v['checks'])
        assert sha(emulator)==report['native_sha256'],'Emulator changed during acceptance'
        report['passed']=True
        report['sif_transfer_semantics']='baseline_observed_not_accepted_as_correct_DMA'
    except Exception as error:
        report['passed']=False;report['failure']=str(error);raise
    finally:
        (output/'validation.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(f'PASS standalone MCP: {len(report["checks"])} live checks; {output / "validation.json"}')

if __name__=='__main__':main()
