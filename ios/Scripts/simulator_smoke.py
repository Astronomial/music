"""Run native AVQueuePlayer and pinned TLS sync in an actual iOS Simulator."""
import json, pathlib, shutil, signal, subprocess, tempfile, time, urllib.parse
run = lambda *args: subprocess.check_output(args, text=True, timeout=180).strip()
root = pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='forma-simulator-') as directory:
    server = subprocess.Popen(['node', str(root/'ios/Scripts/smoke-sync-server.mjs'), directory])
    device = None
    launch = None
    container = None
    passed = False
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
        else: raise RuntimeError('Test server did not publish a fresh pairing code')
        pairing = code.read_text()
        parsed = urllib.parse.urlparse(pairing)
        parameters = urllib.parse.parse_qs(parsed.query)
        if parsed.scheme != 'forma' or parsed.netloc != 'pair' or not all(parameters.get(key) for key in ('host', 'port', 'pin', 'code')):
            raise RuntimeError('Test server published an incomplete pairing code')
        # --console intentionally stays attached; inspect app reports without blocking on launch.
        slow_audio = (pathlib.Path(directory)/'audio-fixture-url.txt').read_text().strip()
        audio_address = urllib.parse.urlparse(slow_audio)
        if audio_address.scheme != 'http' or audio_address.hostname != '127.0.0.1' or not audio_address.port:
            raise RuntimeError('Audio fixture must stay on loopback')
        launch = subprocess.Popen(['xcrun','simctl','launch','--console',device,'music.forma.ios','--forma-smoke','--forma-pair-code',pairing,'--forma-slow-audio',slow_audio], stdout=stream, stderr=stream)
        print('Launching native app; waiting for foreground audio', flush=True)
        last_stage = None
        launch_deadline = time.monotonic() + 240
        test_deadline = None
        while time.monotonic() < (test_deadline or launch_deadline):
            if launch.poll() is not None and launch.returncode != 0: raise RuntimeError('Simulator launch failed')
            if report.exists():
                result = json.loads(report.read_text())
                # A cold CI simulator may spend minutes starting the process.
                # Give native assertions their own budget after the first report;
                # their audio-start and buffering limits remain unchanged.
                if test_deadline is None: test_deadline = time.monotonic() + 180
                if result.get('stage') != last_stage:
                    last_stage = result.get('stage'); print('Native stage: ' + str(last_stage), flush=True)
                if result['status'] == 'failed':
                    print(json.dumps(result, indent=2), flush=True)
                    (root/'ios/native-smoke-result.json').write_text(json.dumps(result, indent=2))
                    raise RuntimeError(result.get('error', 'Native startup failed'))
                if result.get('stage') == 'awaiting-background': break
            time.sleep(.5)
        else:
            if report.exists(): (root/'ios/native-smoke-result.json').write_text(report.read_text())
            raise RuntimeError('Native app did not reach background transition handshake; last stage: ' + str(last_stage))
        run('xcrun','simctl','io',device,'screenshot',str(root/'ios/native-layout.png'))
        design = container/'Documents/design-audit'
        if not design.is_dir(): raise RuntimeError('Native design captures missing')
        # Moving to Safari is the assertion's only purpose: opening our pinned
        # self-signed HTTPS server additionally invokes unrelated browser/TLS UI.
        # A cold Simulator may time out its launch RPC after Safari actually opens;
        # confirm the app's background handshake before retrying or failing.
        for attempt in range(3):
            try:
                subprocess.check_output(['xcrun', 'simctl', 'launch', device, 'com.apple.mobilesafari'], text=True, timeout=30)
                break
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                if report.exists():
                    state = json.loads(report.read_text())
                    if state.get('stage') == 'playing' or state.get('status') == 'passed': break
                if attempt == 2: raise
                print('Retrying cold Safari launch', flush=True)
                time.sleep(2)
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
        passed = True
    finally:
        if container and (container/'Documents/native-startup.txt').exists():
            shutil.copy2(container/'Documents/native-startup.txt', root/'ios/native-startup.txt')
            print((container/'Documents/native-startup.txt').read_text(), flush=True)
        if device and not passed:
            def diagnose(args, name, timeout=20):
                try:
                    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
                    (root/'ios'/name).write_text((result.stdout + result.stderr)[-60000:])
                except Exception as error: (root/'ios'/name).write_text(str(error))
            diagnose(['xcrun','simctl','io',device,'screenshot',str(root/'ios/native-failure.png')], 'native-screenshot-log.txt')
            diagnose(['xcrun','simctl','spawn',device,'log','show','--last','6m','--style','compact','--predicate','process == "Forma"'], 'native-system-log.txt')
            processes = subprocess.run(['pgrep','-x','Forma'], capture_output=True, text=True)
            if processes.stdout.strip():
                pid = processes.stdout.strip().splitlines()[-1]
                diagnose(['sample',pid,'3','-file',str(root/'ios/native-process-sample.txt')], 'native-sample-log.txt')
        if container and (container/'Documents/design-audit').is_dir():
            shutil.copytree(container/'Documents/design-audit', root/'ios/native-design', dirs_exist_ok=True)
        if launch and launch.poll() is None:
            launch.terminate()
            try: launch.wait(timeout=10)
            except subprocess.TimeoutExpired: launch.kill(); launch.wait()
        stream.close()
        print(console.read_text()[-16000:], flush=True)
        server.terminate()
        try: server.wait(timeout=10)
        except subprocess.TimeoutExpired: server.kill(); server.wait()
