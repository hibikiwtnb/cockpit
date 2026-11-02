# SPDX-License-Identifier: LGPL-2.1-or-later
"""Read GPU metrics using sysfs and optional vendor tools."""
import csv
import io
import json
import math
import re
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


def radeon_metrics(card):
    """Sample the selected DRM card; permissions and missing tools are optional."""
    try:
        result = subprocess.run(
            ["radeontop", "-p", "/dev/dri/" + card.name, "-d", "-", "-l", "1"],
            capture_output=True, text=True, timeout=3, check=True,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"},
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    busy = re.search(r"(?:^|, )gpu ([\d.]+)%", result.stdout)
    vram = re.search(r"(?:^|, )vram ([\d.]+)% ([\d.]+)mb", result.stdout)
    metrics = {}
    if busy:
        metrics["busy"] = number(busy[1])
    if vram:
        metrics["used"] = number(vram[2])
        metrics["vramPercent"] = number(vram[1])
    return metrics


def temperature(device):
    for sensor in sorted((device / "hwmon").glob("hwmon*/temp1_input")):
        value = number(read(sensor))
        if value is not None:
            return value / 1000
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
        metrics = dict(id=card.name, name=driver + " (" + card.name + ")",
                            busy=number(read(device / "gpu_busy_percent")),
                            used=used / 1048576 if used is not None else None,
                            total=total / 1048576 if total is not None else None,
                       temperature=temperature(device))
        if driver == "radeon":
            metrics.update(radeon_metrics(card))
        devices.append(metrics)
    return devices


if __name__ == "__main__":
    print(json.dumps(collect()))
