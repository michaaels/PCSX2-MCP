#!/usr/bin/env python3
"""Submit an operator attestation to the Qt point-options test; never edit points."""
import argparse
import json
import os
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('action', choices=['verify', 'stop'])
    parser.add_argument('--case', choices=['condition', 'logging', 'max_hits'])
    parser.add_argument('--actor', choices=['human', 'computer-use'])
    parser.add_argument('--confirm-gui-edit', action='store_true')
    args = parser.parse_args()
    output = args.output.resolve(strict=True)
    session = json.loads((output / 'session.json').read_text(encoding='utf-8'))
    if session.get('kind') != 'real_qt_point_options_ownership' or session.get('preflight'):
        parser.error('Expected the Qt point-options session')
    if Path(session['data_directory']).resolve() != output / 'instance':
        parser.error('Session data root mismatch')
    if session['phase'] != 'awaiting_gui_edit':
        parser.error('Session is not awaiting a GUI edit: ' + session['phase'])
    if args.action == 'verify' and (not args.confirm_gui_edit or not args.actor or args.case != session.get('gui_case')):
        parser.error('verify requires the current --case, --actor and --confirm-gui-edit after a real Qt edit')
    current = json.loads((output / 'control.json').read_text(encoding='utf-8'))
    sequence = current.get('sequence')
    if type(sequence) is not int or sequence < 0:
        parser.error('Invalid control sequence')
    command = {'sequence': sequence + 1, 'action': args.action}
    if args.action == 'verify':
        command.update(case=args.case, actor=args.actor, confirmed_gui_edit=True)
    temporary = output / 'control.next.json'
    temporary.write_text(json.dumps(command) + '\n', encoding='utf-8')
    os.replace(temporary, output / 'control.json')
    print('Submitted', args.action, 'sequence', command['sequence'], 'to', output)


if __name__ == '__main__':
    main()
