# SPDX-License-Identifier: LGPL-2.1-or-later
"""Read hardware specifications and sensor snapshots without desktop dependencies."""
import ctypes
import fcntl
import json
import platform
import re
import struct
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path


def read(path):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None


def run(command):
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=6,
                              check=True, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}).stdout
    except (OSError, subprocess.SubprocessError):
        return ''


def number(value):
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


def scaled(path, scale=1):
    value = number(read(path))
    return value / scale if value is not None else None


def parse_fields(text):
    result = {}
    for line in text.splitlines():
        if ':' in line:
            key, value = line.strip().split(':', 1)
            if value.strip():
                result[key.strip()] = value.strip()
    return result


def cpu_details():
    try:
        data = json.loads(run(['lscpu', '--json']))
    except ValueError:
        data = {}
    fields = {}

    def visit(items):
        for item in items:
            fields[item['field'].rstrip(':')] = item.get('data')
            visit(item.get('children', []))

    visit(data.get('lscpu', []))
    first = parse_fields((read('/proc/cpuinfo') or '').split('\n\n')[0])
    dmi = [parse_fields(section) for section in run(['dmidecode', '-t', 'processor']).split('Processor Information')[1:]]
    cpufreq = Path('/sys/devices/system/cpu/cpu0/cpufreq')
    sensors = []
    for hwmon in sorted(Path('/sys/class/hwmon').glob('hwmon*')):
        if read(hwmon / 'name') not in ('coretemp', 'k10temp', 'zenpower'):
            continue
        for sensor in sorted(hwmon.glob('temp*_input')):
            sensors.append({'name': read(sensor.with_name(sensor.name.replace('_input', '_label'))) or sensor.stem,
                            'temperature': scaled(sensor, 1000)})
    return {
        'fields': fields,
        'microcode': (first.get('microcode') or '').strip(),
        'flags': (first.get('flags') or first.get('Features') or fields.get('Flags') or '').split(),
        'sockets': [{key: value.strip() for key, value in socket.items()} for socket in dmi],
        'base_mhz': scaled(cpufreq / 'base_frequency', 1000),
        'current_mhz': scaled(cpufreq / 'scaling_cur_freq', 1000),
        'governor': read(cpufreq / 'scaling_governor'),
        'frequency_driver': read(cpufreq / 'scaling_driver'),
        'temperatures': sensors,
    }


def radeon_info(device, card):
    # Read-only Linux Radeon DRM UAPI: include/uapi/drm/radeon_drm.h.
    # GEM_INFO (0x1c) reports exact VRAM/GTT sizes; INFO (0x27) returns sensor/capability values.
    result = {}
    nodes = sorted((device / 'drm').glob('renderD*')) + [Path('/dev/dri') / card.name]
    for node in nodes:
        try:
            with open('/dev/dri/' + node.name, 'rb', buffering=0) as stream:
                version = bytearray(64)
                fcntl.ioctl(stream.fileno(), 0xc0406400, version, True)
                result['drm_version'] = '.'.join(str(part) for part in struct.unpack_from('=iii', version))
                data = bytearray(24)
                fcntl.ioctl(stream.fileno(), 0xc018645c, data, True)
                gtt, vram, visible = struct.unpack('=QQQ', data)
                result.update(gtt_total=gtt, vram_total=vram, vram_visible=visible)
                for request, key, divisor in [(0x1e, 'vram_used', 1), (0x1f, 'gtt_used', 1),
                                              (0x20, 'compute_units', 1), (0x21, 'temperature', 1000),
                                              (0x22, 'core_mhz', 1), (0x23, 'memory_mhz', 1),
                                              (0x1a, 'max_core_mhz', 1000)]:
                    value = ctypes.c_uint64()
                    query = struct.pack('=IIQ', request, 0, ctypes.addressof(value))
                    try:
                        fcntl.ioctl(stream.fileno(), 0xc0106467, query)
                        result[key] = value.value / divisor
                    except OSError:
                        pass
            break
        except OSError:
            continue
    return result


def nvidia_details():
    try:
        root = ET.fromstring(run(['nvidia-smi', '-q', '-x']))
    except ET.ParseError:
        return {}
    mapping = {
        'name': 'product_name', 'architecture': 'product_architecture', 'brand': 'product_brand',
        'uuid': 'uuid', 'vbios': 'vbios_version', 'serial': 'serial',
        'memory_total': 'fb_memory_usage/total', 'memory_used': 'fb_memory_usage/used',
        'memory_free': 'fb_memory_usage/free', 'bar1_total': 'bar1_memory_usage/total',
        'temperature': 'temperature/gpu_temp', 'temperature_limit': 'temperature/gpu_temp_max_threshold',
        'fan': 'fan_speed', 'utilization': 'utilization/gpu_util',
        'memory_utilization': 'utilization/memory_util', 'performance_state': 'performance_state',
        'core_clock': 'clocks/graphics_clock', 'sm_clock': 'clocks/sm_clock',
        'memory_clock': 'clocks/mem_clock', 'max_core_clock': 'max_clocks/graphics_clock',
        'max_memory_clock': 'max_clocks/mem_clock', 'power_draw': 'gpu_power_readings/power_draw',
        'power_limit': 'gpu_power_readings/power_limit', 'ecc': 'ecc_mode/current_ecc',
        'pcie_generation': 'pci/pci_gpu_link_info/pcie_gen/current_link_gen',
        'pcie_max_generation': 'pci/pci_gpu_link_info/pcie_gen/max_link_gen',
    }
    devices = {}
    for gpu in root.findall('gpu'):
        bus = (gpu.findtext('pci/pci_bus_id') or gpu.get('id', ''))[-12:].lower()
        values = {key: gpu.findtext(path) for key, path in mapping.items()}
        values['driver_version'] = root.findtext('driver_version')
        values['cuda_version'] = root.findtext('cuda_version')
        values['power_draw'] = values['power_draw'] or gpu.findtext('power_readings/power_draw')
        values['power_limit'] = values['power_limit'] or gpu.findtext('power_readings/power_limit')
        devices[bus] = {key: value for key, value in values.items()
                        if value and value not in ('N/A', 'Not Supported', '[Not Supported]')}
    return devices


def gpu_details():
    nvidia = nvidia_details()
    cards = []
    libraries = dict(line.split(' ', 1) for line in run([
        'dpkg-query', '-W', '-f=${Package} ${Version}\n',
        'libgl1-mesa-dri', 'libegl-mesa0', 'libdrm-radeon1',
    ]).splitlines() if ' ' in line)
    for card in sorted(Path('/sys/class/drm').glob('card[0-9]*')):
        if not card.name[4:].isdigit():
            continue
        device = card / 'device'
        if not device.exists():
            continue
        bus = device.resolve().name
        driver = (device / 'driver').resolve().name
        pci = {key: value.strip() for key, value in parse_fields(run(['lspci', '-vmmnn', '-s', bus])).items()}
        result = {'card': card.name, 'bus': bus, 'driver': driver, 'kernel': platform.release(),
                  'driver_source': read('/sys/module/' + driver + '/srcversion'),
                  'vendor': pci.get('Vendor'), 'name': pci.get('SDevice') or pci.get('Device') or card.name,
                  'chip': (pci.get('Device') or '').split(' [', 1)[0], 'board_vendor': pci.get('SVendor'),
                  'vendor_id': read(device / 'vendor'), 'device_id': read(device / 'device'),
                  'subsystem_vendor': read(device / 'subsystem_vendor'),
                  'subsystem_device': read(device / 'subsystem_device'),
                  'revision': read(device / 'revision'), 'link_speed': read(device / 'current_link_speed'),
                  'link_width': read(device / 'current_link_width'),
                  'max_link_speed': read(device / 'max_link_speed'),
                  'max_link_width': read(device / 'max_link_width'),
                  'power_profile': read(device / 'power_dpm_state'),
                  'performance_level': read(device / 'power_dpm_force_performance_level'),
                  'vbios': read(device / 'vbios_version'),
                  'vram_total': scaled(device / 'mem_info_vram_total'),
                  'vram_used': scaled(device / 'mem_info_vram_used'),
                  'gtt_total': scaled(device / 'mem_info_gtt_total'),
                  'gtt_used': scaled(device / 'mem_info_gtt_used'),
                  'busy': scaled(device / 'gpu_busy_percent'),
                  'memory_busy': scaled(device / 'mem_busy_percent'),
                  'displays': []}
        for hwmon in sorted((device / 'hwmon').glob('hwmon*')):
            for filename, key, scale in [('temp1_input', 'temperature', 1000), ('temp1_crit', 'temperature_critical', 1000),
                                         ('freq1_input', 'core_mhz', 1000000), ('fan1_input', 'fan_rpm', 1),
                                         ('power1_average', 'power_watts', 1000000), ('power1_cap', 'power_cap_watts', 1000000)]:
                value = scaled(hwmon / filename, scale)
                if value is not None:
                    result[key] = value
            pwm, maximum = scaled(hwmon / 'pwm1'), scaled(hwmon / 'pwm1_max')
            if pwm is not None and maximum:
                result['fan_pwm'] = 100 * pwm / maximum
        if driver == 'radeon':
            result.update(radeon_info(device, card))
            minor = (read(card / 'dev') or '').split(':')[-1]
            pm = read('/sys/kernel/debug/dri/' + minor + '/radeon_pm_info') or ''
            voltage = re.search(r'vddc:\s*(\d+)', pm)
            if voltage:
                result['voltage'] = int(voltage[1]) / 1000
            sample = run(['radeontop', '-p', '/dev/dri/' + card.name, '-d', '-', '-l', '1', '-t', '10'])
            busy = re.search(r', gpu ([\d.]+)%', sample)
            if busy:
                result['busy'] = float(busy[1])
        if driver in ('radeon', 'amdgpu', 'i915', 'xe', 'nouveau'):
            result['mesa_dri'] = libraries.get('libgl1-mesa-dri')
            result['mesa_egl'] = libraries.get('libegl-mesa0')
            result['libdrm_radeon'] = libraries.get('libdrm-radeon1') if driver == 'radeon' else None
        for connector in sorted(card.parent.glob(card.name + '-*')):
            status = read(connector / 'status')
            result['displays'].append({'name': connector.name[len(card.name) + 1:], 'status': status,
                                       'modes': list(dict.fromkeys((read(connector / 'modes') or '').splitlines()))})
        result['nvidia'] = nvidia.pop(bus.lower(), {})
        result['name'] = result['nvidia'].get('name') or result['name']
        cards.append(result)
    for bus, values in nvidia.items():
        cards.append({'bus': bus, 'name': values.get('name', bus), 'driver': 'nvidia',
                      'kernel': platform.release(), 'nvidia': values, 'displays': []})
    return cards


if __name__ == '__main__':
    print(json.dumps({'cpu': cpu_details(), 'gpus': gpu_details(), 'sampled_at': time.time()}))
