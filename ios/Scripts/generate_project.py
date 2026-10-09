#!/usr/bin/env python3
"""Generate a deterministic, dependency-free Xcode project. Run --check in CI."""
import hashlib
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1]
objects = {}

def uid(name):
    return hashlib.sha1(('forma-ios:' + name).encode()).hexdigest()[:24].upper()

def quote(value):
    return json.dumps(str(value), ensure_ascii=False)

def add(name, body):
    objects[uid(name)] = body
    return uid(name)

sources = sorted((root / 'Forma').glob('*.swift'))
resources = sorted((root / 'Forma' / 'Resources').glob('*'))
files, source_builds, resource_builds = [], [], []
for p in sources + resources:
    name = str(p.relative_to(root))
    kind = 'sourcecode.swift' if p.suffix == '.swift' else 'folder.assetcatalog' if p.suffix == '.xcassets' else 'text'
    ref = add('file:' + name, f'isa = PBXFileReference; lastKnownFileType = {kind}; path = {quote(name)}; sourceTree = "<group>";')
    files.append(ref)
    build = add('build:' + name, f'isa = PBXBuildFile; fileRef = {ref};')
    (source_builds if p.suffix == '.swift' else resource_builds).append(build)
info = add('info', 'isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Forma/Info.plist; sourceTree = "<group>";')
product = add('product', 'isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = Forma.app; sourceTree = BUILT_PRODUCTS_DIR;')
products = add('products', f'isa = PBXGroup; children = ({product},); name = Products; sourceTree = "<group>";')
group = add('group', f'isa = PBXGroup; children = ({", ".join(files + [info, products])},); sourceTree = "<group>";')
framework_builds, packages, dependencies = [], [], []
for name, relative in [('FormaCore', 'Packages/FormaCore'), ('YouTubeKit', 'Vendor/YouTubeKit')]:
    ref = add('package:' + name, f'isa = XCLocalSwiftPackageReference; relativePath = {relative};')
    dep = add('dependency:' + name, f'isa = XCSwiftPackageProductDependency; package = {ref}; productName = {name};')
    framework_builds.append(add('framework:' + name, f'isa = PBXBuildFile; productRef = {dep};'))
    packages.append(ref); dependencies.append(dep)
phase_ids = []
for name, isa, entries in [('sources', 'PBXSourcesBuildPhase', source_builds), ('frameworks', 'PBXFrameworksBuildPhase', framework_builds), ('resources', 'PBXResourcesBuildPhase', resource_builds)]:
    phase_ids.append(add(name, f'isa = {isa}; buildActionMask = 2147483647; files = ({", ".join(entries)},); runOnlyForDeploymentPostprocessing = 0;'))
configs = {}
for scope in ['project', 'target']:
    ids = []
    for mode in ['Debug', 'Release']:
        settings = {'CLANG_ENABLE_MODULES': 'YES', 'SDKROOT': 'iphoneos', 'IPHONEOS_DEPLOYMENT_TARGET': '17.0', 'SWIFT_VERSION': '5.0'}
        if scope == 'target':
            settings.update({'PRODUCT_NAME': 'Forma', 'PRODUCT_BUNDLE_IDENTIFIER': 'music.forma.ios', 'INFOPLIST_FILE': 'Forma/Info.plist', 'GENERATE_INFOPLIST_FILE': 'NO', 'MARKETING_VERSION': '1.1.2', 'CURRENT_PROJECT_VERSION': '7', 'TARGETED_DEVICE_FAMILY': '1,2', 'SUPPORTED_PLATFORMS': 'iphoneos iphonesimulator', 'CODE_SIGN_STYLE': 'Automatic', 'ASSETCATALOG_COMPILER_APPICON_NAME': 'AppIcon', 'LD_RUNPATH_SEARCH_PATHS': '$(inherited) @executable_path/Frameworks', 'SWIFT_STRICT_CONCURRENCY': 'targeted'})
        settings.update({'SWIFT_OPTIMIZATION_LEVEL': '-Onone' if mode == 'Debug' else '-O', 'DEBUG_INFORMATION_FORMAT': 'dwarf' if mode == 'Debug' else 'dwarf-with-dsym'})
        if mode == 'Debug': settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = 'DEBUG'
        body = ' '.join(f'{key} = {quote(value)};' for key, value in sorted(settings.items()))
        ids.append(add(scope + mode, f'isa = XCBuildConfiguration; buildSettings = {{ {body} }}; name = {mode};'))
    configs[scope] = add(scope + 'configs', f'isa = XCConfigurationList; buildConfigurations = ({", ".join(ids)},); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
target = add('target', f'isa = PBXNativeTarget; buildConfigurationList = {configs["target"]}; buildPhases = ({", ".join(phase_ids)},); buildRules = (); dependencies = (); name = Forma; packageProductDependencies = ({", ".join(dependencies)},); productName = Forma; productReference = {product}; productType = "com.apple.product-type.application";')
project = add('project', f'isa = PBXProject; attributes = {{ LastUpgradeCheck = 1600; TargetAttributes = {{ {target} = {{ CreatedOnToolsVersion = 16.0; ProvisioningStyle = Automatic; }}; }}; }}; buildConfigurationList = {configs["project"]}; compatibilityVersion = "Xcode 14.0"; developmentRegion = ru; hasScannedForEncodings = 0; knownRegions = (ru, en, Base,); mainGroup = {group}; packageReferences = ({", ".join(packages)},); productRefGroup = {products}; projectDirPath = ""; projectRoot = ""; targets = ({target},);')
content = '// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {};\n\tobjectVersion = 60;\n\tobjects = {\n' + ''.join(f'\t\t{key} = {{ {body} }};\n' for key, body in sorted(objects.items())) + f'\t}};\n\trootObject = {project};\n}}\n'
scheme = f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3">
 <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="Forma.app" BlueprintName="Forma" ReferencedContainer="container:Forma.xcodeproj"/></BuildActionEntry></BuildActionEntries></BuildAction>
 <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables/></TestAction>
 <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="Forma.app" BlueprintName="Forma" ReferencedContainer="container:Forma.xcodeproj"/></BuildableProductRunnable></LaunchAction>
 <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"/>
 <AnalyzeAction buildConfiguration="Debug"/>
 <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
'''
ET.fromstring(scheme)
output = root / 'Forma.xcodeproj'
outputs = {output / 'project.pbxproj': content, output / 'xcshareddata/xcschemes/Forma.xcscheme': scheme}
for path, data in outputs.items():
    if '--check' in sys.argv:
        if not path.exists() or path.read_text() != data: raise SystemExit(f'Outdated: {path}; run ios/Scripts/generate_project.py')
    else:
        path.parent.mkdir(parents=True, exist_ok=True); path.write_text(data)
print(f'PASS: Xcode project includes {len(sources)} Swift sources, {len(resources)} resources and 2 local packages.')
