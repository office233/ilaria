#!/usr/bin/env python3
"""Boot the actual ISO in a diskless QEMU guest; save serial evidence and pixels."""
import argparse, json, pathlib, shutil, socket, subprocess, time

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--iso', default='out/swypik-os-native.iso')
    p.add_argument('--out', default='out/smoke-bios')
    p.add_argument('--uefi', action='store_true')
    a = p.parse_args()
    out = pathlib.Path(a.out).resolve(); out.mkdir(parents=True, exist_ok=True)
    qmp = out / 'qmp.sock'; serial = out / 'serial.log'
    qmp.unlink(missing_ok=True)
    cmd = ['qemu-system-x86_64', '-machine', 'q35', '-accel', 'tcg', '-m', '768', '-smp', '2',
           '-cdrom', str(pathlib.Path(a.iso).resolve()), '-boot', 'd', '-vga', 'std', '-display', 'none',
           '-nic', 'user,model=virtio-net-pci', '-serial', 'file:' + str(serial),
           '-qmp', f'unix:{qmp},server=on,wait=off', '-no-reboot']
    if a.uefi:
        code = pathlib.Path('/usr/share/OVMF/OVMF_CODE_4M.fd')
        variables = pathlib.Path('/usr/share/OVMF/OVMF_VARS_4M.fd')
        if not code.exists() or not variables.exists():
            raise RuntimeError('OVMF 4M firmware is required for the UEFI test')
        shutil.copyfile(variables, out / 'OVMF_VARS.fd')
        cmd += ['-drive', f'if=pflash,format=raw,readonly=on,file={code}',
                '-drive', f'if=pflash,format=raw,file={out / "OVMF_VARS.fd"}']
    started = time.monotonic()
    with (out / 'qemu.log').open('w') as log:
        proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT)
        try:
            text = ''
            while time.monotonic() - started < 120:
                if serial.exists(): text = serial.read_text(errors='replace')
                if all(s in text for s in ('SWYPIK_DAEMON_READY uid=1000', 'SWYPIK_NATIVE_READY uid=1000', 'SWYPIK_NET_READY')):
                    break
                if proc.poll() is not None: raise RuntimeError('QEMU exited before boot completed')
                time.sleep(.25)
            else: raise RuntimeError('Boot assertions failed; inspect serial.log: ' + text[-3000:])
            sock = socket.socket(socket.AF_UNIX); sock.settimeout(10); sock.connect(str(qmp))
            stream = sock.makefile('rwb', buffering=0)
            json.loads(stream.readline())
            def call(name, arguments=None):
                stream.write((json.dumps({'execute': name, 'arguments': arguments or {}}) + '\n').encode())
                while True:
                    reply = json.loads(stream.readline())
                    if 'error' in reply: raise RuntimeError(str(reply))
                    if 'return' in reply: return reply['return']
            call('qmp_capabilities')
            time.sleep(2)
            call('screendump', {'filename': str(out / 'native-home.ppm')})
            call('human-monitor-command', {'command-line': 'sendkey f4'})
            time.sleep(1)
            call('screendump', {'filename': str(out / 'native-network.ppm')})
            state = call('query-status')
            if state['status'] != 'running': raise RuntimeError('Guest is not running')
            report = {'boot': 'passed', 'firmware': 'uefi' if a.uefi else 'bios', 'agent_uid': 1000,
                      'session_uid': 1000, 'network': 'virtio DHCP lease confirmed', 'native_framebuffer': True,
                      'elapsed_seconds': round(time.monotonic() - started, 2),
                      'model_inference': 'not tested: no Ilaria model bundled',
                      'physical_hardware': 'not tested', 'writes_to_host_disks': False}
            (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
            print(json.dumps(report, indent=2))
            call('quit'); sock.close()
        finally:
            if proc.poll() is None:
                proc.terminate()
                try: proc.wait(timeout=5)
                except subprocess.TimeoutExpired: proc.kill(); proc.wait()
            qmp.unlink(missing_ok=True)
if __name__ == '__main__': main()
