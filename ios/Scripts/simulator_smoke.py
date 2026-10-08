"""Run native AVQueuePlayer and pinned TLS sync in an actual iOS Simulator."""
import json, pathlib, signal, subprocess, tempfile, time
run = lambda *args: subprocess.check_output(args, text=True, timeout=180).strip()
root = pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='forma-simulator-') as directory:
    server = subprocess.Popen(['node', str(root/'ios/Scripts/smoke-sync-server.mjs'), directory])
    device = None
    launch = None
    console = root/'ios/native-smoke-console.txt'
    stream = console.open('w')
    try:
        code = pathlib.Path(directory)/'pair-code.txt'
        for _ in range(50):
            if code.exists(): break
            time.sleep(.1)
        if not code.exists(): raise RuntimeError('TLS server did not start')
        devices = json.loads(run('xcrun','simctl','list','devices','available','-j'))['devices']
        runtimes = sorted(devices.items(), key=lambda entry: (0 if 'iOS-18' in entry[0] else 1, entry[0]))
        selected = next((d for runtime, ds in runtimes if 'iOS' in runtime for d in ds if 'iPhone' in d['name']), None)
        if not selected: raise RuntimeError('No available iPhone simulator')
        device = selected['udid']
        print('Booting simulator: ' + selected['name'], flush=True)
        if selected['state'] != 'Booted': run('xcrun','simctl','boot',device)
        subprocess.check_call(['xcrun','simctl','bootstatus',device,'-b'], timeout=180)
        print('Simulator ready; installing native app', flush=True)
        app = root/'ios/.derived-data/Build/Products/Debug-iphonesimulator/Forma.app'
        run('xcrun','simctl','install',device,str(app))
        container = pathlib.Path(run('xcrun','simctl','get_app_container',device,'music.forma.ios','data'))
        report = container/'Documents/smoke-result.json'
        # Generate the five-minute pairing code after the simulator's cold boot.
        previous = code.stat().st_mtime_ns
        server.send_signal(signal.SIGUSR1)
        for _ in range(50):
            if code.stat().st_mtime_ns != previous: break
            time.sleep(.1)
        # --console intentionally stays attached; inspect app reports without blocking on launch.
        launch = subprocess.Popen(['xcrun','simctl','launch','--console',device,'music.forma.ios','--forma-smoke','--forma-pair-code',code.read_text()], stdout=stream, stderr=stream)
        print('Launching native app; waiting for foreground audio', flush=True)
        last_stage = None
        for _ in range(360):
            if launch.poll() is not None and launch.returncode != 0: raise RuntimeError('Simulator launch failed')
            if report.exists():
                result = json.loads(report.read_text())
                if result.get('stage') != last_stage:
                    last_stage = result.get('stage'); print('Native stage: ' + str(last_stage), flush=True)
                if result['status'] == 'failed':
                    print(json.dumps(result, indent=2), flush=True)
                    (root/'ios/native-smoke-result.json').write_text(json.dumps(result, indent=2))
                    raise RuntimeError(result.get('error', 'Native startup failed'))
                if result.get('nativeStarts', 0) > 0: break
            time.sleep(.5)
        else: raise RuntimeError('Native audio did not start in foreground')
        run('xcrun','simctl','openurl',device,'https://127.0.0.1:30377/')
        for _ in range(60):
            if report.exists():
                result = json.loads(report.read_text())
                if result['status'] != 'running':
                    print(json.dumps(result, indent=2), flush=True)
                    (root/'ios/native-smoke-result.json').write_text(json.dumps(result,indent=2))
                    if result['status'] != 'passed': raise RuntimeError(result.get('error','Native smoke failed'))
                    break
            time.sleep(1)
        else: raise RuntimeError('Native simulator smoke timed out')
    finally:
        if launch and launch.poll() is None:
            launch.terminate()
            try: launch.wait(timeout=10)
            except subprocess.TimeoutExpired: launch.kill(); launch.wait()
        stream.close()
        print(console.read_text()[-16000:], flush=True)
        server.terminate()
        try: server.wait(timeout=10)
        except subprocess.TimeoutExpired: server.kill(); server.wait()
