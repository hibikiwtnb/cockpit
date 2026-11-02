# SPDX-License-Identifier: LGPL-2.1-or-later
"""Read GPU metrics without elevated privileges or additional Python packages."""
import csv
import io
import json
import math
import subprocess
from pathlib import Path


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) and result >= 0 else None
    except (TypeError, ValueError):
        return None


def read(path):
    try:
        return path.read_text().strip()
    except OSError:
        return None


def collect():
    devices = []
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,name,utilization.gpu,memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=2, check=True,
        )
        for row in csv.reader(io.StringIO(result.stdout), skipinitialspace=True):
            if len(row) != 5:
                continue
            index, name, busy, used, total = row
            devices.append(dict(id="nvidia-" + index, name=name, busy=number(busy),
                                used=number(used), total=number(total)))
    except (OSError, subprocess.SubprocessError):
        pass

    for card in sorted(Path("/sys/class/drm").glob("card[0-9]*")):
        if not card.name[4:].isdigit():
            continue
        device = card / "device"
        vendor = read(device / "vendor")
        if vendor is None or (vendor == "0x10de" and devices):
            continue
        driver = (device / "driver").resolve().name
        used = number(read(device / "mem_info_vram_used"))
        total = number(read(device / "mem_info_vram_total"))
        devices.append(dict(id=card.name, name=driver + " (" + card.name + ")",
                            busy=number(read(device / "gpu_busy_percent")),
                            used=used / 1048576 if used is not None else None,
                            total=total / 1048576 if total is not None else None))
    return devices


if __name__ == "__main__":
    print(json.dumps(collect()))
