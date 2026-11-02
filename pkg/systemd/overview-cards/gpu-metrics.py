# SPDX-License-Identifier: LGPL-2.1-or-later
"""Read GPU metrics using sysfs and optional vendor tools."""
import csv
import io
import json
import math
import re
import subprocess
import signal
import sys
import threading
import time
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
    return parse_radeon(result.stdout)


def parse_radeon(output):
    busy = re.search(r"(?:^|, )gpu ([\d.]+)%", output)
    vram = re.search(r"(?:^|, )vram ([\d.]+)% ([\d.]+)mb", output)
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


def parse_nvidia(output):
    samples = {}
    for row in csv.reader(io.StringIO(output), skipinitialspace=True):
        if len(row) != 5:
            continue
        index, name, busy, used, total = row
        samples[index] = dict(id="nvidia-" + index, name=name, busy=number(busy),
                             used=number(used), total=number(total))
    return samples


def query_nvidia():
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,name,utilization.gpu,memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=2, check=True,
        )
        return list(parse_nvidia(result.stdout).values())
    except (OSError, subprocess.SubprocessError):
        return []


def collect(streams=None):
    devices = streams.nvidia() if streams is not None else query_nvidia()

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
            metrics.update(streams.radeon(card) if streams is not None else radeon_metrics(card))
        devices.append(metrics)
    return devices


class VendorStreams:
    """Keep vendor tools alive only while the overview is visible."""

    def __init__(self):
        self.processes = {}
        self.values = {}
        self.lock = threading.Lock()

    def _start(self, key, command, parse):
        try:
            process = subprocess.Popen(
                command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                text=True, bufsize=1,
                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"},
            )
        except OSError:
            return
        self.processes[key] = process

        def receive():
            for line in process.stdout:
                sample = parse(line)
                if sample:
                    with self.lock:
                        self.values.setdefault(key, {}).update(sample)

        threading.Thread(target=receive, daemon=True).start()

    def start(self):
        self._start("nvidia", [
            "nvidia-smi", "--query-gpu=index,name,utilization.gpu,memory.used,memory.total",
            "--format=csv,noheader,nounits", "--loop=3",
        ], parse_nvidia)
        for card in sorted(Path("/sys/class/drm").glob("card[0-9]*")):
            if card.name[4:].isdigit() and (card / "device/driver").resolve().name == "radeon":
                self._start(card.name, ["radeontop", "-p", "/dev/dri/" + card.name,
                                       "-d", "-", "-i", "3", "-t", "10"], parse_radeon)

    def nvidia(self):
        with self.lock:
            values = [dict(value) for value in self.values.get("nvidia", {}).values()]
        process = self.processes.get("nvidia")
        if process is not None and process.poll() is not None:
            for value in values:
                value.update(busy=None, used=None)
        return values

    def radeon(self, card):
        process = self.processes.get(card.name)
        if process is None or process.poll() is not None:
            return {}
        with self.lock:
            return dict(self.values.get(card.name, {}))

    def close(self):
        for process in self.processes.values():
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            process.stdout.close()


def watch():
    streams = VendorStreams()

    def stop(_signal, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        streams.start()
        while True:
            print(json.dumps(collect(streams)), flush=True)
            time.sleep(3)
    except BrokenPipeError:
        pass
    finally:
        streams.close()


if __name__ == "__main__":
    if "--watch" in sys.argv[1:]:
        watch()
    else:
        print(json.dumps(collect()))
