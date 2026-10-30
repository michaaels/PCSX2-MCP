#!/usr/bin/env python3
"""Control a running guided GUI test; never edits PCSX2 or its breakpoints."""
import argparse
import json
from pathlib import Path
import os

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output',type=Path,help='Output directory of the running gui-ownership-live.mjs')
    parser.add_argument('action',choices=['verify','stop'])
    parser.add_argument('--confirm-gui-edit',action='store_true',help='Attest that you manually edited the indicated breakpoint in Qt')
    args=parser.parse_args()
    output=args.output.resolve(strict=True)
    session=json.loads((output/'session.json').read_text(encoding='utf-8'))
    if session.get('kind')!='guided_source_breakpoint_gui_ownership' or session.get('preflight'):
        parser.error('Expected a running guided test, not a preflight report')
    if Path(session['data_directory']).resolve()!=output/'instance':
        parser.error('Session data root does not match the requested test output')
    if session['phase']!='awaiting_gui_edit':
        parser.error('The guided session is not waiting for GUI editing: '+session['phase'])
    if args.action=='verify' and not args.confirm_gui_edit:
        parser.error('verify requires --confirm-gui-edit after you make the Qt edit')
    current=json.loads((output/'control.json').read_text(encoding='utf-8'))
    sequence=current.get('sequence')
    if type(sequence) is not int or sequence<0:parser.error('Invalid control sequence')
    command={'sequence':sequence+1,'action':args.action}
    if args.action=='verify':command['confirmed_gui_edit']=True
    temporary=output/'control.next.json'
    temporary.write_text(json.dumps(command)+'\n',encoding='utf-8')
    os.replace(temporary,output/'control.json')
    print('Submitted',args.action,'sequence',command['sequence'],'to',output)

if __name__=='__main__':main()
