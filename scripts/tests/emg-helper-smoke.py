"""Exercise the real headless helpers with a simulated serial device, no hardware."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]


def wait_for(predicate, process):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if predicate():
            return
        if process.poll() is not None:
            raise AssertionError(process.communicate()[0])
        time.sleep(.1)
    raise AssertionError("Timed out waiting for helper")


for name in ["emg_dual_obs.py", "emg_single.py"]:
    with tempfile.TemporaryDirectory(prefix="sarah-emg-test-") as directory:
        folder = Path(directory)
        (folder / "serial.py").write_text('''import time
class Serial:
    def __init__(self, *args, **kwargs): pass
    @property
    def in_waiting(self): return 0
    def reset_input_buffer(self): pass
    def readline(self):
        time.sleep(.02)
        return b"400,300\\n"
    def close(self): pass
''')
        env = {**os.environ, "PYTHONPATH": directory, "EMG_HEADLESS": "1", "MPLBACKEND": "Agg", "EMG_OBS_ENABLED": "false", "EMG_ACCEPT_DUAL": "1",
               "EMG_STOP_FILE": str(folder / "stop"), "EMG_SESSIONS_DIR": str(folder / "sessions"),
               "EMG_COMMAND_FILE": str(folder / "command.json"), "EMG_COMMAND_STATUS_FILE": str(folder / "status.json"),
               "EMG_DUAL_CAL_FILE": str(folder / "cal.json"), "EMG_SINGLE_CAL_FILE": str(folder / "cal.json")}
        for key in ["LEFT", "RIGHT", "DIFF", "LEVEL"]:
            env[f"EMG_{key}_TEXT_PATH"] = str(folder / f"{key}.txt")
        import sys
        process = subprocess.Popen([sys.executable, "-u", str(ROOT / "tools/capture/emg" / name)], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            output = folder / ("LEFT.txt" if "dual" in name else "LEVEL.txt")
            wait_for(lambda: output.exists() and output.stat().st_size > 0, process)
            (folder / "command.json").write_text(json.dumps({"id": "smoke", "action": "save_calibration"}))
            wait_for(lambda: (folder / "cal.json").exists() and (folder / "status.json").exists(), process)
            assert json.loads((folder / "status.json").read_text())["status"] == "applied"
            (folder / "stop").write_text("stop")
            process.wait(timeout=8)
            assert process.returncode == 0, process.communicate()[0]
            print(f"PASS {name}: live output, calibration acknowledgement, graceful stop")
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate()
