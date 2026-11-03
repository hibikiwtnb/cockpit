# SPDX-License-Identifier: LGPL-2.1-or-later
import ctypes
import importlib.util
import json
import struct
import unittest
from pathlib import Path
from unittest.mock import mock_open, patch

SCRIPT = Path(__file__).resolve().parents[2] / 'pkg/systemd/hardware-details.py'
spec = importlib.util.spec_from_file_location('hardware_details', SCRIPT)
hardware = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hardware)


class TestHardwareDetails(unittest.TestCase):
    def test_proc_fields_and_empty_values(self):
        fields = hardware.parse_fields('microcode\t: 0xf8\nflags\t: avx avx2\nSerial Number:  \n')
        self.assertEqual(fields, {'microcode': '0xf8', 'flags': 'avx avx2'})

    def test_nested_lscpu_and_firmware_values(self):
        cpu = {'lscpu': [{'field': 'Vendor ID:', 'data': 'GenuineIntel', 'children': [
            {'field': 'Model name:', 'data': 'Xeon'}, {'field': 'Socket(s):', 'data': '1'}]}]}
        def run(command):
            if command[0] == 'lscpu':
                return json.dumps(cpu)
            return 'Processor Information\n\tVoltage: 1.0 V\n\tSocket Designation: CPU1\n'
        with patch.object(hardware, 'run', side_effect=run), \
                patch.object(hardware, 'read', return_value='microcode\t: 0xf8\nflags\t: avx avx2'), \
                patch.object(hardware.Path, 'glob', return_value=[]):
            result = hardware.cpu_details()
        self.assertEqual(result['fields']['Model name'], 'Xeon')
        self.assertEqual(result['microcode'], '0xf8')
        self.assertEqual(result['flags'], ['avx', 'avx2'])
        self.assertEqual(result['sockets'][0]['Voltage'], '1.0 V')

    def test_nvidia_bus_matching_and_unsupported_fields(self):
        xml = '''<nvidia_smi_log><driver_version>595.71.05</driver_version><gpu id="00000000:23:00.0">
            <product_name>RTX A3000</product_name><serial>N/A</serial>
            <pci><pci_bus_id>00000000:23:00.0</pci_bus_id></pci>
            <fb_memory_usage><total>12288 MiB</total><used>0 MiB</used></fb_memory_usage>
            <power_readings><power_draw>25.0 W</power_draw></power_readings>
            </gpu></nvidia_smi_log>'''
        with patch.object(hardware, 'run', return_value=xml):
            result = hardware.nvidia_details()['0000:23:00.0']
        self.assertEqual(result['name'], 'RTX A3000')
        self.assertEqual(result['memory_used'], '0 MiB')
        self.assertEqual(result['power_draw'], '25.0 W')
        self.assertNotIn('serial', result)
        with patch.object(hardware, 'run', return_value=''):
            self.assertEqual(hardware.nvidia_details(), {})

    def test_read_only_radeon_queries_and_units(self):
        values = {0x1e: 64 * 1048576, 0x1f: 8 * 1048576, 0x20: 6,
                  0x21: 35000, 0x22: 300, 0x23: 300, 0x1a: 825000}
        def ioctl(_fd, request, data, *_args):
            if request == 0xc0406400:
                struct.pack_into('=iii', data, 0, 2, 50, 0)
            elif request == 0xc018645c:
                data[:] = struct.pack('=QQQ', 2 * 1073741824, 1073741824, 256 * 1048576)
            else:
                query, _, address = struct.unpack('=IIQ', data)
                ctypes.c_uint64.from_address(address).value = values[query]
        with patch('builtins.open', mock_open()), \
                patch.object(hardware.Path, 'glob', return_value=[]), \
                patch.object(hardware.fcntl, 'ioctl', side_effect=ioctl):
            result = hardware.radeon_info(Path('/fake/device'), Path('card0'))
        self.assertEqual(result['vram_total'], 1073741824)
        self.assertEqual(result['compute_units'], 6)
        self.assertEqual(result['max_core_mhz'], 825)
        self.assertEqual(result['temperature'], 35)
        self.assertEqual(result['drm_version'], '2.50.0')

    def test_denied_driver_queries_do_not_invent_values(self):
        with patch('builtins.open', side_effect=PermissionError), \
                patch.object(hardware.Path, 'glob', return_value=[]):
            self.assertEqual(hardware.radeon_info(Path('/fake/device'), Path('card0')), {})


if __name__ == '__main__':
    unittest.main()
