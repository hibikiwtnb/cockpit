# SPDX-License-Identifier: LGPL-2.1-or-later
"""GPU sampling works without NVIDIA tools and preserves unavailable readings."""
import importlib.util
import subprocess
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'pkg/systemd/overview-cards/gpu-metrics.py'
spec = importlib.util.spec_from_file_location('gpu_metrics', SCRIPT)
gpu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gpu)


class TestGpuMetrics(unittest.TestCase):
    def test_multiple_nvidia_devices_and_unavailable_values(self):
        output = '0, NVIDIA A3000, 42, 1024, 12288\n1, NVIDIA A3000, [N/A], 0, 12288\n'
        with patch.object(gpu.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, output)), \
                patch.object(gpu.Path, 'glob', return_value=[]):
            devices = gpu.collect()
        self.assertEqual(len(devices), 2)
        self.assertEqual(devices[0]['busy'], 42)
        self.assertEqual(devices[0]['used'], 1024)
        self.assertIsNone(devices[1]['busy'])
        self.assertEqual(devices[1]['used'], 0)

    def test_missing_nvidia_tool_and_unsupported_radeon(self):
        card = Path('/sys/class/drm/card0')
        def read(path):
            return '0x1002' if path.name == 'vendor' else None
        with patch.object(gpu.subprocess, 'run', side_effect=FileNotFoundError), \
                patch.object(gpu.Path, 'glob', return_value=[card]), \
                patch.object(gpu, 'read', side_effect=read):
            devices = gpu.collect()
        self.assertEqual(len(devices), 1)
        self.assertIsNone(devices[0]['busy'])
        self.assertIsNone(devices[0]['used'])

    def test_amdgpu_sysfs_units(self):
        with tempfile.TemporaryDirectory() as directory:
            card = Path(directory) / 'card0'
            device = card / 'device'
            device.mkdir(parents=True)
            for name, value in [('vendor', '0x1002'), ('gpu_busy_percent', '57'),
                                ('mem_info_vram_used', '1048576'),
                                ('mem_info_vram_total', '8388608')]:
                (device / name).write_text(value)
            with patch.object(gpu.subprocess, 'run', side_effect=FileNotFoundError), \
                    patch.object(gpu.Path, 'glob', return_value=[card]):
                devices = gpu.collect()
        self.assertEqual(devices[0]['busy'], 57)
        self.assertEqual(devices[0]['used'], 1)
        self.assertEqual(devices[0]['total'], 8)

    def test_radeon_sample_and_card_selection(self):
        output = ('Dumping to -, line limit 1.\n'
                  '1234: bus 01, gpu 42.50%, vram 5.72% 58.55mb, '
                  'mclk inf% 0.300ghz, sclk 36.36% 0.300ghz\n')
        with patch.object(gpu.subprocess, 'run',
                          return_value=subprocess.CompletedProcess([], 0, output)) as run:
            metrics = gpu.radeon_metrics(Path('/sys/class/drm/card1'))
        self.assertEqual(metrics, {'busy': 42.5, 'used': 58.55, 'vramPercent': 5.72})
        self.assertIn('/dev/dri/card1', run.call_args.args[0])
        self.assertEqual(run.call_args.kwargs['env']['LC_ALL'], 'C')

    def test_radeon_unavailable_and_timeout(self):
        for error in [FileNotFoundError(), PermissionError(),
                      subprocess.CalledProcessError(1, 'radeontop'),
                      subprocess.TimeoutExpired('radeontop', 3)]:
            with patch.object(gpu.subprocess, 'run', side_effect=error):
                self.assertEqual(gpu.radeon_metrics(Path('card0')), {})

    def test_radeon_invalid_sample_does_not_report_zero(self):
        result = subprocess.CompletedProcess([], 0, 'Cannot access GPU registers')
        with patch.object(gpu.subprocess, 'run', return_value=result):
            self.assertEqual(gpu.radeon_metrics(Path('card0')), {})

    def test_temperature_units_and_missing_sensor(self):
        with tempfile.TemporaryDirectory() as directory:
            device = Path(directory)
            self.assertIsNone(gpu.temperature(device))
            sensor = device / 'hwmon/hwmon2'
            sensor.mkdir(parents=True)
            (sensor / 'temp1_input').write_text('34500')
            self.assertEqual(gpu.temperature(device), 34.5)

    def test_streaming_collection_does_not_restart_vendor_tools(self):
        streams = gpu.VendorStreams()
        streams.processes['nvidia'] = unittest.mock.Mock(poll=lambda: None)
        streams.values['nvidia'] = {'0': dict(id='nvidia-0', name='NVIDIA', busy=25, used=1024, total=4096)}
        with patch.object(gpu.subprocess, 'run', side_effect=AssertionError('Vendor tool restarted')), \
                patch.object(gpu.Path, 'glob', return_value=[]):
            for _ in range(3):
                self.assertEqual(gpu.collect(streams)[0]['busy'], 25)

    def test_dead_vendor_stream_does_not_leave_stale_metrics(self):
        streams = gpu.VendorStreams()
        streams.processes['nvidia'] = unittest.mock.Mock(poll=lambda: 1)
        streams.values['nvidia'] = {'0': dict(id='nvidia-0', name='NVIDIA', busy=99, used=1024, total=4096)}
        self.assertIsNone(streams.nvidia()[0]['busy'])
        self.assertIsNone(streams.nvidia()[0]['used'])
        streams.processes['card0'] = unittest.mock.Mock(poll=lambda: 1)
        streams.values['card0'] = {'busy': 99, 'used': 1024}
        self.assertEqual(streams.radeon(Path('card0')), {})

    def test_stream_cleanup_terminates_children(self):
        streams = gpu.VendorStreams()
        process = unittest.mock.Mock()
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired('radeontop', 1), 0]
        streams.processes['card0'] = process
        streams.close()
        process.terminate.assert_called_once()
        process.kill.assert_called_once()
        process.stdout.close.assert_called_once()

    def test_driver_timeout(self):
        with patch.object(gpu.subprocess, 'run', side_effect=subprocess.TimeoutExpired('nvidia-smi', 2)), \
                patch.object(gpu.Path, 'glob', return_value=[]):
            self.assertEqual(gpu.collect(), [])

    def test_invalid_and_nonfinite_metrics(self):
        for value in ['[N/A]', 'NaN', 'inf', '-1', None]:
            self.assertIsNone(gpu.number(value))
        self.assertEqual(gpu.number('0'), 0)


if __name__ == '__main__':
    unittest.main()
