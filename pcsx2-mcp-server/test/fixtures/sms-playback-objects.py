"""Fixture-only addresses for read-only SMS menu selection/identity checks."""
import json
from pathlib import Path
import sys
import importlib.util

spec = importlib.util.spec_from_file_location('sms_objects', Path(__file__).with_name('sms-incident-objects.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

if __name__ == '__main__':
    try:
        print(json.dumps(helper.inspect(Path(sys.argv[1]), sys.argv[2], unit_name='SMS_Jellyfin.c', names={
            's_Stage': 4, 's_Pending': 4, 's_Count': 4, 's_Selected': 4,
            's_ID': 64*33, 's_DetailID': 33, 's_Library': 33, 's_Session': 37, 's_Boot': 17})))
    except Exception:
        print(json.dumps({'error': 'SMS playback fixture metadata unavailable or unsupported'}))
        sys.exit(1)
