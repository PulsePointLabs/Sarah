"""Retain partial serial lines; never treat half a number as a sample."""
import math


def latest_line(ser, dual=False):
    chunk = ser.read(min(8192, max(1, ser.in_waiting)))
    buffer = getattr(ser, '_sarah_partial', b'') + chunk
    lines = buffer.split(b'\n')
    ser._sarah_partial = lines.pop()[-8192:]
    latest = None
    for line in lines:
        try:
            text = line.decode('ascii').strip()
            parts = text.split(',')
            if dual and len(parts) != 2:
                continue
            if not dual and len(parts) not in (1, 2):
                continue
            if all(math.isfinite(float(v)) and 0 <= float(v) <= 1023 for v in parts):
                latest = text
        except (ValueError, UnicodeError):
            continue
    return latest
