import csv
import json
import time
import collections
import os
from datetime import datetime
from pathlib import Path

import serial
import matplotlib.pyplot as plt
import matplotlib as mpl

# Stop matplotlib stealing shortcut keys
mpl.rcParams["keymap.fullscreen"] = []
mpl.rcParams["keymap.quit"] = []
mpl.rcParams["keymap.save"] = []

try:
    import obsws_python as obs
except ImportError:
    obs = None


# ================= SETTINGS =================

BASE_DIR = Path(__file__).resolve().parent

SERIAL_PORT = os.getenv("EMG_SERIAL_PORT", "COM5")
SERIAL_BAUD = int(os.getenv("EMG_SERIAL_BAUD", "115200"))

CAL_FILE = Path(os.getenv("EMG_DUAL_CAL_FILE", BASE_DIR / "emg_calibration_dual_simple.json"))

# Defaults based on your raw test
REST_L = 230.0
MAX_L = 700.0

REST_R = 115.0
MAX_R = 400.0

# False: A0 = Left, A1 = Right
# True:  A0 = Right, A1 = Left
FLIP_LR = False

# Clipping control
HEADROOM = 1.35          # higher = less clipping
DISPLAY_MAX = 150.0      # allows above-100 detail on graph/CSV

# OBS
OBS_ENABLED = os.getenv("EMG_OBS_ENABLED", "true").lower() not in {"0", "false", "no"}
OBS_HOST = os.getenv("OBS_HOST", "192.168.0.33")
OBS_PORT = int(os.getenv("OBS_PORT", "4455"))
OBS_PASSWORD = os.getenv("OBS_PASSWORD", "")

# Output files for HTML overlay
LEFT_TXT = Path(os.getenv("EMG_LEFT_TEXT_PATH", BASE_DIR / "emg_left.txt"))
RIGHT_TXT = Path(os.getenv("EMG_RIGHT_TEXT_PATH", BASE_DIR / "emg_right.txt"))
DIFF_TXT = Path(os.getenv("EMG_DIFF_TEXT_PATH", BASE_DIR / "emg_diff.txt"))
COMMAND_FILE = Path(os.getenv("EMG_COMMAND_FILE", LEFT_TXT.parent / "emg_command.json"))
COMMAND_STATUS_FILE = Path(os.getenv("EMG_COMMAND_STATUS_FILE", LEFT_TXT.parent / "emg_command_status.json"))

OUTPUT_DIR = Path(os.getenv("EMG_SESSIONS_DIR", BASE_DIR / "emg_sessions"))
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Plot/update
PUBLISH_HZ = 30
PLOT_SECONDS = 20

# Signal feel
ALPHA_ENV = 0.18
ATTACK = 0.38
RELEASE = 0.25

NOISE_FLOOR_PCT = 1.0


# ================= LOAD CALIBRATION =================

if CAL_FILE.exists():
    try:
        data = json.loads(CAL_FILE.read_text())
        REST_L = float(data.get("REST_L", REST_L))
        MAX_L = float(data.get("MAX_L", MAX_L))
        REST_R = float(data.get("REST_R", REST_R))
        MAX_R = float(data.get("MAX_R", MAX_R))
        HEADROOM = float(data.get("HEADROOM", HEADROOM))
        FLIP_LR = bool(data.get("FLIP_LR", FLIP_LR))

        print(
            f"Loaded calibration: "
            f"L {REST_L:.1f}/{MAX_L:.1f}, "
            f"R {REST_R:.1f}/{MAX_R:.1f}, "
            f"HEADROOM={HEADROOM:.2f}, "
            f"FLIP_LR={FLIP_LR}"
        )

    except Exception as e:
        print(f"Could not load calibration: {e}")


# ================= HELPERS =================

def clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def normalize(env, rest, max_val):
    """
    Normalize with headroom.
    This reduces hard clipping at 100%.
    Values can exceed 100 up to DISPLAY_MAX.
    """
    if max_val <= rest + 10:
        return 0.0

    effective_max = rest + ((max_val - rest) * HEADROOM)
    pct = ((env - rest) / (effective_max - rest)) * 100.0
    pct = clamp(pct, 0.0, DISPLAY_MAX)

    if pct < NOISE_FLOOR_PCT:
        pct = 0.0

    return pct


def parse_dual_line(s):
    try:
        parts = s.strip().split(",")
        if len(parts) < 2:
            return None, None
        return float(parts[0]), float(parts[1])
    except Exception:
        return None, None


def get_latest_dual_line(ser):
    """
    Backlog-proof serial reader.
    Uses only the newest A0,A1 line.
    """
    latest = None

    waiting = ser.in_waiting
    if waiting:
        chunk = ser.read(waiting).decode(errors="ignore")
        for line in chunk.splitlines():
            line = line.strip()
            if "," in line and not line.startswith("A0"):
                latest = line

    if latest is None:
        line = ser.readline().decode(errors="ignore").strip()
        if "," in line and not line.startswith("A0"):
            latest = line

    return latest


def connect_obs():
    if not OBS_ENABLED:
        print("OBS disabled.")
        return None

    if obs is None:
        print("OBS package missing. Install with: py -m pip install obsws-python")
        return None

    try:
        client = obs.ReqClient(
            host=OBS_HOST,
            port=OBS_PORT,
            password=OBS_PASSWORD,
            timeout=3
        )
        print(f"OBS connected: {OBS_HOST}:{OBS_PORT}")
        return client

    except Exception as e:
        print(f"OBS connection failed: {e}")
        return None


def get_obs_state(client):
    if client is None:
        return False, "DISCONNECTED"

    try:
        status = client.get_record_status()
        active = bool(getattr(status, "output_active", False))
        paused = bool(getattr(status, "output_paused", False))

        if active and paused:
            return True, "RECORDING_PAUSED"
        if active:
            return True, "RECORDING"
        return False, "STOPPED"

    except Exception as e:
        return False, f"OBS_ERROR:{e}"


def new_csv():
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = OUTPUT_DIR / f"emg_dual_simple_{stamp}.csv"

    f = path.open("w", newline="", encoding="utf-8")
    writer = csv.writer(f)

    writer.writerow([
        "time_s",
        "unix_time",
        "iso_time",
        "left_raw",
        "left_env",
        "left_pct",
        "right_raw",
        "right_env",
        "right_pct",
        "diff_pct",
        "rest_l",
        "max_l",
        "rest_r",
        "max_r",
        "headroom",
        "flip_lr",
        "obs_recording",
        "obs_state",
        "marker"
    ])

    return path, f, writer


def write_csv_row(writer, t0, raw_l, env_l, pct_l,
                  raw_r, env_r, pct_r,
                  obs_recording, obs_state, marker=""):

    now = time.time()
    t = time.perf_counter() - t0

    writer.writerow([
        f"{t:.3f}",
        f"{now:.6f}",
        datetime.now().isoformat(timespec="milliseconds"),
        f"{raw_l:.1f}",
        f"{env_l:.1f}",
        f"{pct_l:.1f}",
        f"{raw_r:.1f}",
        f"{env_r:.1f}",
        f"{pct_r:.1f}",
        f"{(pct_l - pct_r):.1f}",
        f"{REST_L:.1f}",
        f"{MAX_L:.1f}",
        f"{REST_R:.1f}",
        f"{MAX_R:.1f}",
        f"{HEADROOM:.2f}",
        int(bool(FLIP_LR)),
        int(bool(obs_recording)),
        obs_state,
        marker
    ])


# ================= MAIN =================

def main():
    global REST_L, MAX_L, REST_R, MAX_R, HEADROOM, FLIP_LR

    print(f"Opening serial {SERIAL_PORT} @ {SERIAL_BAUD}...")
    ser = serial.Serial(SERIAL_PORT, SERIAL_BAUD, timeout=0.05)
    time.sleep(1.2)
    ser.reset_input_buffer()
    print("Serial connected.")

    obs_client = connect_obs()
    recording, obs_state = get_obs_state(obs_client)
    last_recording = recording
    print(f"OBS state: {obs_state}")

    dt = 1.0 / PUBLISH_HZ
    max_points = int(PLOT_SECONDS * PUBLISH_HZ)

    buf_l = collections.deque([0.0] * max_points, maxlen=max_points)
    buf_r = collections.deque([0.0] * max_points, maxlen=max_points)

    raw_l = raw_r = 0.0
    env_l = None
    env_r = None

    pct_l = 0.0
    pct_r = 0.0

    csv_file = None
    csv_writer = None
    csv_path = None
    session_t0 = None

    plt.ion()
    fig, ax = plt.subplots()
    line_l, = ax.plot([], [], label="Left")
    line_r, = ax.plot([], [], label="Right")

    ax.legend(loc="upper right")
    ax.set_title("Dual EMG — Simple")
    ax.set_ylabel("Level (%)")
    ax.set_ylim(0, DISPLAY_MAX)

    def save_calibration():
        CAL_FILE.write_text(json.dumps({
            "REST_L": REST_L,
            "MAX_L": MAX_L,
            "REST_R": REST_R,
            "MAX_R": MAX_R,
            "HEADROOM": HEADROOM,
            "FLIP_LR": FLIP_LR
        }, indent=2))

        print(
            f"Saved calibration: "
            f"L {REST_L:.1f}/{MAX_L:.1f}, "
            f"R {REST_R:.1f}/{MAX_R:.1f}, "
            f"HEADROOM={HEADROOM:.2f}, "
            f"FLIP_LR={FLIP_LR}"
        )

    def write_command_status(command, status, message):
        COMMAND_STATUS_FILE.write_text(json.dumps({
            "id": command.get("id"),
            "action": command.get("action"),
            "status": status,
            "message": message,
            "applied_at": datetime.now().isoformat(),
            "calibration": {
                "rest_l": REST_L,
                "max_l": MAX_L,
                "rest_r": REST_R,
                "max_r": MAX_R,
                "headroom": HEADROOM,
                "flip_lr": FLIP_LR,
            }
        }, indent=2))

    def apply_calibration_action(action, save=False):
        global REST_L, MAX_L, REST_R, MAX_R, HEADROOM, FLIP_LR
        nonlocal env_l, env_r

        if action == "flip_lr":
            FLIP_LR = not FLIP_LR
            message = f"Flip set to {FLIP_LR} ({'A0=Right, A1=Left' if FLIP_LR else 'A0=Left, A1=Right'})"
            print(message)
            if save:
                save_calibration()
            return True, message

        if action == "headroom_up":
            HEADROOM += 0.05
            message = f"HEADROOM increased: {HEADROOM:.2f}"
            print(message)
            if save:
                save_calibration()
            return True, message

        if action == "headroom_down":
            HEADROOM = max(1.0, HEADROOM - 0.05)
            message = f"HEADROOM decreased: {HEADROOM:.2f}"
            print(message)
            if save:
                save_calibration()
            return True, message

        if action == "save_calibration":
            save_calibration()
            return True, "Calibration saved."

        if env_l is None or env_r is None:
            message = "No EMG data yet."
            print(message)
            return False, message

        if action == "set_both_rest":
            REST_L = env_l
            REST_R = env_r
            message = f"Set BOTH REST: L={REST_L:.1f}, R={REST_R:.1f}"

        elif action == "set_both_max":
            MAX_L = env_l
            MAX_R = env_r
            message = f"Set BOTH MAX: L={MAX_L:.1f}, R={MAX_R:.1f}"

        elif action == "set_left_rest":
            REST_L = env_l
            message = f"Set LEFT REST: {REST_L:.1f}"

        elif action == "set_right_rest":
            REST_R = env_r
            message = f"Set RIGHT REST: {REST_R:.1f}"

        elif action == "set_left_max":
            MAX_L = env_l
            message = f"Set LEFT MAX: {MAX_L:.1f}"

        elif action == "set_right_max":
            MAX_R = env_r
            message = f"Set RIGHT MAX: {MAX_R:.1f}"
        else:
            return False, f"Unsupported calibration command: {action}"

        print(message)
        if save:
            save_calibration()
        return True, message

    def consume_app_command():
        if not COMMAND_FILE.exists():
            return
        try:
            command = json.loads(COMMAND_FILE.read_text())
            COMMAND_FILE.unlink(missing_ok=True)
            ok, message = apply_calibration_action(command.get("action", ""), command.get("save", True))
            write_command_status(command, "applied" if ok else "rejected", message)
        except Exception as exc:
            write_command_status({"id": None, "action": "unknown"}, "rejected", str(exc))

    def on_key(event):
        key = event.key.lower() if event.key else ""
        actions = {
            "v": "flip_lr",
            "up": "headroom_up",
            "down": "headroom_down",
            "r": "set_both_rest",
            "m": "set_both_max",
            "a": "set_left_rest",
            "d": "set_right_rest",
            "z": "set_left_max",
            "x": "set_right_max",
            "c": "save_calibration",
        }
        if key in actions:
            apply_calibration_action(actions[key], save=False)

    fig.canvas.mpl_connect("key_press_event", on_key)

    print("Running simplified dual EMG.")
    print("Keys:")
    print("  V = flip left/right mapping")
    print("  R = set both rest")
    print("  M = set both max")
    print("  A = set left rest")
    print("  D = set right rest")
    print("  Z = set left max")
    print("  X = set right max")
    print("  Up Arrow = increase headroom")
    print("  Down Arrow = decrease headroom")
    print("  C = save calibration")
    print(f"Current mapping: {'A0=Right, A1=Left' if FLIP_LR else 'A0=Left, A1=Right'}")
    print("Waiting for OBS recording start...")

    last_pub = time.time()

    try:
        while True:
            s = get_latest_dual_line(ser)
            if not s:
                continue

            a0, a1 = parse_dual_line(s)
            if a0 is None:
                continue

            if FLIP_LR:
                raw_l, raw_r = a1, a0
            else:
                raw_l, raw_r = a0, a1

            consume_app_command()

            if env_l is None:
                env_l = raw_l
                env_r = raw_r

            env_l = ALPHA_ENV * raw_l + (1 - ALPHA_ENV) * env_l
            env_r = ALPHA_ENV * raw_r + (1 - ALPHA_ENV) * env_r

            level_raw_l = normalize(env_l, REST_L, MAX_L)
            level_raw_r = normalize(env_r, REST_R, MAX_R)

            a_l = ATTACK if level_raw_l > pct_l else RELEASE
            a_r = ATTACK if level_raw_r > pct_r else RELEASE

            pct_l = a_l * level_raw_l + (1 - a_l) * pct_l
            pct_r = a_r * level_raw_r + (1 - a_r) * pct_r

            now = time.time()

            if now - last_pub >= dt:
                last_pub = now

                recording, obs_state = get_obs_state(obs_client)

                if recording and not last_recording:
                    csv_path, csv_file, csv_writer = new_csv()
                    session_t0 = time.perf_counter()

                    write_csv_row(
                        csv_writer, session_t0,
                        raw_l, env_l, pct_l,
                        raw_r, env_r, pct_r,
                        recording, obs_state,
                        marker="RECORD_START"
                    )
                    csv_file.flush()
                    print(f"Recording started -> {csv_path}")

                elif not recording and last_recording:
                    if csv_writer is not None:
                        write_csv_row(
                            csv_writer, session_t0,
                            raw_l, env_l, pct_l,
                            raw_r, env_r, pct_r,
                            recording, obs_state,
                            marker="RECORD_STOP"
                        )
                        csv_file.flush()
                        csv_file.close()

                        print(f"Recording stopped -> saved {csv_path}")

                        csv_writer = None
                        csv_file = None
                        csv_path = None
                        session_t0 = None

                last_recording = recording

                if recording and csv_writer is not None:
                    write_csv_row(
                        csv_writer, session_t0,
                        raw_l, env_l, pct_l,
                        raw_r, env_r, pct_r,
                        recording, obs_state,
                        marker=""
                    )
                    csv_file.flush()

                buf_l.append(pct_l)
                buf_r.append(pct_r)

                xs = list(range(len(buf_l)))
                line_l.set_data(xs, list(buf_l))
                line_r.set_data(xs, list(buf_r))

                mapping = "A0→R / A1→L" if FLIP_LR else "A0→L / A1→R"

                ax.set_xlim(0, max(10, len(buf_l)))
                ax.set_ylim(0, DISPLAY_MAX)
                ax.set_xlabel(
                    f"L:{pct_l:.1f}% raw:{raw_l:.0f} env:{env_l:.1f} "
                    f"cal:{REST_L:.0f}/{MAX_L:.0f} | "
                    f"R:{pct_r:.1f}% raw:{raw_r:.0f} env:{env_r:.1f} "
                    f"cal:{REST_R:.0f}/{MAX_R:.0f} | "
                    f"Δ:{(pct_l - pct_r):+.1f} | "
                    f"headroom:{HEADROOM:.2f} | {mapping} | OBS:{obs_state}"
                )

                fig.canvas.draw_idle()
                fig.canvas.flush_events()
                plt.pause(0.001)

                LEFT_TXT.write_text(f"{pct_l:.1f}")
                RIGHT_TXT.write_text(f"{pct_r:.1f}")
                DIFF_TXT.write_text(f"{(pct_l - pct_r):.1f}")

    except KeyboardInterrupt:
        print("\nStopping...")

        if csv_writer is not None and csv_file is not None:
            write_csv_row(
                csv_writer, session_t0,
                raw_l, env_l, pct_l,
                raw_r, env_r, pct_r,
                last_recording, obs_state,
                marker="SCRIPT_STOP"
            )
            csv_file.flush()
            csv_file.close()
            print(f"Closed active CSV: {csv_path}")

    ser.close()
    print("Serial closed.")


if __name__ == "__main__":
    main()
