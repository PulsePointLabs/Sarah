"""Exercise both production helper loops with a simulated serial device, no OBS/UI."""
import concurrent.futures
import csv
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).parent.resolve()


def exercise(channels):
    with tempfile.TemporaryDirectory(prefix='sarah-emg-guided-') as directory:
        base=Path(directory)
        values=base/'values.json'; values.write_text('[100,100]')
        wrapper=base/'runner.py'
        wrapper.write_text('''import sys, types, time, json, os, runpy
from pathlib import Path
serial=types.ModuleType('serial')
class Serial:
    def __init__(self,*args,**kwargs): pass
    in_waiting=20
    def read(self,n):
        time.sleep(.01)
        try:v=json.loads(Path(os.environ['TEST_VALUES']).read_text())
        except ValueError:return b''
        return (','.join(map(str,v))+'\\n').encode()
    def reset_input_buffer(self):pass
    def close(self):pass
serial.Serial=Serial
sys.modules['serial']=serial
obs=types.ModuleType('obsws_python')
class Client:
    def __init__(self,*args,**kwargs):pass
    def get_record_status(self):return types.SimpleNamespace(output_active=True,output_paused=False)
obs.ReqClient=Client
sys.modules['obsws_python']=obs
sys.path.insert(0,os.environ['TEST_MODULES'])
runpy.run_path(os.environ['TEST_SCRIPT'],run_name='__main__')
''')
        env={**os.environ,'TEST_VALUES':str(values),'TEST_MODULES':str(ROOT),
            'TEST_SCRIPT':str(ROOT/('emg_dual_obs.py' if channels==2 else 'emg_single.py')),
            'EMG_HEADLESS':'1','MPLBACKEND':'Agg','EMG_OBS_ENABLED':'true','EMG_ACCEPT_DUAL':'1',
            'EMG_COMMAND_FILE':str(base/'emg_command.json'),'EMG_COMMAND_STATUS_FILE':str(base/'emg_command_status.json'),
            'EMG_STOP_FILE':str(base/'stop'),'EMG_HEARTBEAT_FILE':'', 'EMG_SESSIONS_DIR':str(base/'sessions'),
            'EMG_SINGLE_CAL_FILE':str(base/'cal.json'),'EMG_DUAL_CAL_FILE':str(base/'cal.json')}
        for key in ['LEFT','RIGHT','DIFF','LEVEL']:env[f'EMG_{key}_TEXT_PATH']=str(base/f'{key}.txt')
        with (base/'output.log').open('w') as log:
            child=subprocess.Popen([sys.executable,str(wrapper)],env=env,stdout=log,stderr=log)
            try:
                def wait_for(predicate,timeout=15):
                    until=time.monotonic()+timeout
                    while time.monotonic()<until:
                        if child.poll() is not None:raise AssertionError((base/'output.log').read_text())
                        try:
                            s=json.loads((base/'emg_setup_status.json').read_text())
                            if predicate(s):return s
                        except (OSError,ValueError):pass
                        time.sleep(.05)
                    raise AssertionError('Timed out: '+(base/'emg_setup_status.json').read_text())
                def command(action):
                    (base/'emg_command.json').write_text(json.dumps(dict(id=action,action=action,save=False)))
                    wait_for(lambda s:s['calibration']['phase']=='preparing' if action!='guided_save' else s['calibration']['saved'])
                wait_for(lambda s:s['fresh'])
                command('guided_rest');wait_for(lambda s:s['calibration']['phase']=='accepted')
                for i in range(channels):
                    v=[100,100];v[i]=300;values.write_text(json.dumps(v))
                    command(f'guided_hold_{i}');wait_for(lambda s:s['calibration']['phase']=='settling')
                    values.write_text('[100,100]');wait_for(lambda s:s['calibration']['phase']=='accepted')
                command('guided_save')
                assert json.loads((base/'cal.json').read_text())['HEADROOM']==1.0
                status=json.loads((base/'emg_command_status.json').read_text())
                assert status['status']=='applied',status
                assert status['calibration']['valid'] and status['calibration']['saved']
                values.write_text('[300,300]')
                time.sleep(2)
                pct=float((base/('LEFT.txt' if channels==2 else 'LEVEL.txt')).read_text())
                assert 95<=pct<=105,pct
            finally:
                (base/'stop').write_text('stop')
                try:child.wait(timeout=5)
                except subprocess.TimeoutExpired:child.kill();child.wait()
            with next((base/'sessions').glob('*.csv')).open() as recording:
                rows=list(csv.DictReader(recording))
            pct_key='left_pct' if channels==2 else 'level_pct'
            invalid=[r for r in rows if r['calibration_valid']=='False']
            valid=[r for r in rows if r['calibration_valid']=='True']
            assert invalid and valid
            assert all(r[pct_key]=='' for r in invalid)
            assert all(r[pct_key]!='' for r in valid)
            assert list((base/'sessions').glob('*.metadata.json'))



class HelperIntegration(unittest.TestCase):
    def test_single_and_dual_helpers_calibrate_without_browser(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            for result in pool.map(exercise,[1,2]):self.assertIsNone(result)

if __name__=='__main__':unittest.main()
