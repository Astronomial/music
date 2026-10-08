"""Run native AVQueuePlayer and pinned TLS sync in an actual iOS Simulator."""
import json, os, pathlib, subprocess, tempfile, time
run = lambda *args: subprocess.check_output(args, text=True).strip()
root = pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='forma-simulator-') as directory:
    server = subprocess.Popen(['node', str(root/'ios/Scripts/smoke-sync-server.mjs'), directory])
    device = None
    try:
        code = pathlib.Path(directory)/'pair-code.txt'
        for _ in range(50):
            if code.exists(): break
            time.sleep(.1)
        if not code.exists(): raise RuntimeError('TLS server did not start')
        devices = json.loads(run('xcrun','simctl','list','devices','available','-j'))['devices']
        selected = next((d for runtime, ds in devices.items() if 'iOS' in runtime for d in ds if 'iPhone' in d['name']), None)
        if not selected: raise RuntimeError('No available iPhone simulator')
        device = selected['udid']
        if selected['state'] != 'Booted': run('xcrun','simctl','boot',device)
        subprocess.check_call(['xcrun','simctl','bootstatus',device,'-b'])
        app = root/'ios/.derived-data/Build/Products/Debug-iphonesimulator/Forma.app'
        run('xcrun','simctl','install',device,str(app))
        run('xcrun','simctl','launch',device,'music.forma.ios','--forma-smoke','--forma-pair-code',code.read_text())
        container = pathlib.Path(run('xcrun','simctl','get_app_container',device,'music.forma.ios','data'))
        report = container/'Documents/smoke-result.json'
        time.sleep(5)
        run('xcrun','simctl','openurl',device,'https://127.0.0.1:30377/') # Safari backgrounds Forma; audio must keep advancing.
        for _ in range(60):
            if report.exists():
                result = json.loads(report.read_text())
                if result['status'] != 'running':
                    print(json.dumps(result, indent=2))
                    (root/'ios/native-smoke-result.json').write_text(json.dumps(result,indent=2))
                    if result['status'] != 'passed': raise RuntimeError(result.get('error','Native smoke failed'))
                    break
            time.sleep(1)
        else: raise RuntimeError('Native simulator smoke timed out')
    finally:
        server.terminate(); server.wait(timeout=10)
