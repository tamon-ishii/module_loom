#!/usr/bin/env python3
import glob
import argparse
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PLUGIN_DIR = os.path.join(PROJECT_ROOT, "plugins", "pycharm")
SRC_JAVA = os.path.join(PLUGIN_DIR, "src", "main", "java")
SRC_RES = os.path.join(PLUGIN_DIR, "src", "main", "resources")
BUILD_DIR = os.path.join(PROJECT_ROOT, "target", "pycharm-plugin")
CLASSES_DIR = os.path.join(BUILD_DIR, "classes")
JAR_OUTPUT = os.path.join(BUILD_DIR, "moduleloom.jar")

PYCHARM_HOME = os.environ.get("PYCHARM_HOME", "")
JAVAC_BIN = os.environ.get("JAVAC_BIN") or os.path.join(PYCHARM_HOME, "jbr", "bin", "javac")

def build():
    if not PYCHARM_HOME:
        raise RuntimeError("Set PYCHARM_HOME to an unpacked PyCharm installation")
    print("=== Building PyCharm Plugin for ModuleLoom ===")
    subprocess.run(["npm", "run", "build"], cwd=PROJECT_ROOT, check=True)
    web_resources = os.path.join(SRC_RES, "web")
    shutil.rmtree(web_resources, ignore_errors=True)
    shutil.copytree(os.path.join(PROJECT_ROOT, "dist"), web_resources)
    stage_local_analyzer()
    stage_local_jscpd()
    plugin_version = os.environ.get("MODULELOOM_VERSION") or datetime.now(timezone.utc).strftime("%Y.%m.%d.%H%M%S")
    if os.path.exists(CLASSES_DIR):
        shutil.rmtree(CLASSES_DIR)
    os.makedirs(CLASSES_DIR, exist_ok=True)

    # 1. Collect classpath jars
    classpath_jars = []
    for pattern in [
        os.path.join(PYCHARM_HOME, "lib", "*.jar"),
        os.path.join(PYCHARM_HOME, "plugins", "jcef-plugin", "lib", "modules", "*.jar"),
    ]:
        classpath_jars.extend(glob.glob(pattern))

    if not os.path.isfile(JAVAC_BIN) or not classpath_jars:
        raise RuntimeError("Set PYCHARM_HOME to an unpacked PyCharm installation containing jbr/bin/javac and lib/*.jar")

    classpath = ":".join(classpath_jars)
    print(f"Collected {len(classpath_jars)} jars for compilation classpath.")

    # 2. Collect Java source files
    java_files = []
    for root, _, files in os.walk(SRC_JAVA):
        for f in files:
            if f.endswith(".java"):
                java_files.append(os.path.join(root, f))

    print(f"Compiling {len(java_files)} Java source file(s)...")
    compile_cmd = [
        JAVAC_BIN,
        "-cp", classpath,
        "-d", CLASSES_DIR,
        "--release", "21"
    ] + java_files

    res = subprocess.run(compile_cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print("Compilation failed:")
        print(res.stderr)
        sys.exit(1)
    print("Java compilation succeeded.")

    # 3. Create Plugin JAR
    print(f"Packaging JAR into {JAR_OUTPUT}...")
    with tempfile.NamedTemporaryFile(dir=BUILD_DIR, suffix=".jar", delete=False) as temp_file:
        temp_jar = temp_file.name
    try:
        with zipfile.ZipFile(temp_jar, "w", zipfile.ZIP_DEFLATED) as jar:
            # Add compiled classes
            for root, _, files in os.walk(CLASSES_DIR):
                for f in files:
                    abs_path = os.path.join(root, f)
                    rel_path = os.path.relpath(abs_path, CLASSES_DIR)
                    jar.write(abs_path, rel_path)

            # Add resources (META-INF, web assets)
            for root, _, files in os.walk(SRC_RES):
                for f in files:
                    abs_path = os.path.join(root, f)
                    rel_path = os.path.relpath(abs_path, SRC_RES)
                    if rel_path == os.path.join("META-INF", "plugin.xml"):
                        with open(abs_path, encoding="utf-8") as source:
                            descriptor = source.read().replace("${pluginVersion}", plugin_version)
                        jar.writestr("META-INF/plugin.xml", descriptor)
                    else:
                        jar.write(abs_path, rel_path)

        validate_jar(temp_jar)
        os.replace(temp_jar, JAR_OUTPUT)
    finally:
        if os.path.exists(temp_jar):
            os.remove(temp_jar)

    print(f"Plugin JAR created successfully: version {plugin_version} ({os.path.getsize(JAR_OUTPUT)} bytes).")

def stage_local_analyzer():
    system = platform.system().lower()
    machine = platform.machine().lower()
    arm64 = machine in ("aarch64", "arm64")
    if system == "windows" and not arm64:
        platform_name, filename = "windows-x64", "analyze.exe"
    elif system == "linux" and not arm64:
        platform_name, filename = "linux-x64", "analyze"
    elif system == "darwin":
        platform_name, filename = ("macos-arm64" if arm64 else "macos-x64"), "analyze"
    else:
        print(f"No local analyzer bundle target for {system}/{machine}.")
        return

    destination = os.path.join(SRC_RES, "bin", platform_name, filename)
    candidates = [
        os.path.join(PROJECT_ROOT, "target", "release", filename),
        os.path.join(PROJECT_ROOT, "target", "debug", filename),
    ]
    valid_candidates = [path for path in candidates if os.path.isfile(path)]
    if valid_candidates:
        # Local builds must include the current analyzer source, even when a
        # previously built release executable has a newer timestamp.
        subprocess.run(["cargo", "build", "--locked", "--bin", "analyze"],
                       cwd=PROJECT_ROOT, check=True)
        source = os.path.join(PROJECT_ROOT, "target", "debug", filename)
    else:
        # CI stages prebuilt binaries for every supported platform here.
        source = None
    if source is None:
        if os.path.isfile(destination):
            print(f"Keeping existing local analyzer: {destination}")
            return
        print(f"No local analyzer found for {platform_name}; the plugin will use PATH fallback.")
        return
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    shutil.copy2(source, destination)
    if system != "windows":
        os.chmod(destination, 0o755)
    print(f"Bundled latest local analyzer: {destination} (from {source})")

def stage_local_jscpd():
    system = platform.system().lower()
    machine = platform.machine().lower()
    arm64 = machine in ("aarch64", "arm64")
    if system == "windows" and not arm64:
        platform_name, filename = "windows-x64", "jscpd.exe"
    elif system == "linux" and not arm64:
        platform_name, filename = "linux-x64", "jscpd"
    elif system == "darwin":
        platform_name, filename = ("macos-arm64" if arm64 else "macos-x64"), "jscpd"
    else:
        return

    destination = os.path.join(SRC_RES, "bin", platform_name, filename)
    candidates = [
        os.path.join(PROJECT_ROOT, ".venv", "Scripts" if system == "windows" else "bin", filename),
        shutil.which(filename),
    ]
    source = next((path for path in candidates if path and os.path.isfile(path)), None)
    if source is not None:
        version = subprocess.run([source, "--version"], capture_output=True, text=True)
        if version.returncode != 0 or version.stdout.strip() != "jscpd 5.3.2":
            source = None
    if source is not None and not os.path.isfile(destination):
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        shutil.copy2(source, destination)
        if system != "windows":
            os.chmod(destination, 0o755)
    if os.path.isfile(destination):
        version = subprocess.run([destination, "--version"], capture_output=True, text=True)
        if version.returncode != 0 or version.stdout.strip() != "jscpd 5.3.2":
            raise RuntimeError(f"Bundled jscpd must be v5.3.2: {destination}")
        license_source = os.path.join(PROJECT_ROOT, "third_party", "jscpd", "LICENSE")
        license_destination = os.path.join(SRC_RES, "licenses", "jscpd", "LICENSE")
        os.makedirs(os.path.dirname(license_destination), exist_ok=True)
        shutil.copy2(license_source, license_destination)
        print(f"Bundled local jscpd: {destination} with {license_destination}")

def validate_jar(path):
    with zipfile.ZipFile(path) as jar:
        bad_file = jar.testzip()
        if bad_file is not None:
            raise RuntimeError(f"Corrupt JAR entry: {bad_file}")
        if any(name.startswith("bin/") and os.path.basename(name) in ("jscpd", "jscpd.exe")
               for name in jar.namelist()) and "licenses/jscpd/LICENSE" not in jar.namelist():
            raise RuntimeError("Bundled jscpd requires licenses/jscpd/LICENSE")

def install(profile=None):
    validate_jar(JAR_OUTPUT)
    shutil.rmtree(os.path.expanduser("~/.cache/moduleloom/web"), ignore_errors=True)
    # Install into all existing PyCharm profiles, including newly created versions.
    target_plugin_roots = sorted(glob.glob(os.path.expanduser("~/.local/share/JetBrains/PyCharm*")))
    if profile:
        target_plugin_roots = [root for root in target_plugin_roots if os.path.basename(root) == profile]

    installed = 0
    for root_dir in target_plugin_roots:
        if os.path.isdir(root_dir):
            dest_dir = os.path.join(root_dir, "moduleloom", "lib")
            os.makedirs(dest_dir, exist_ok=True)
            dest_jar = os.path.join(dest_dir, "moduleloom.jar")
            # Replacing the inode keeps an IDE's open JAR handle on the old,
            # complete archive until it is restarted.
            with tempfile.NamedTemporaryFile(dir=dest_dir, suffix=".jar", delete=False) as temp_file:
                temp_jar = temp_file.name
            try:
                shutil.copy2(JAR_OUTPUT, temp_jar)
                validate_jar(temp_jar)
                os.replace(temp_jar, dest_jar)
            finally:
                if os.path.exists(temp_jar):
                    os.remove(temp_jar)
            print(f"Installed plugin to: {dest_jar}")
            installed += 1

    if installed == 0:
        print("Warning: No target PyCharm plugin directories found to install.")
    else:
        print(f"Successfully installed to {installed} PyCharm environment(s).")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build and install the local PyCharm plugin")
    parser.add_argument("--build-only", action="store_true", help="Build the JAR without installing")
    parser.add_argument("--install-only", action="store_true", help="Install an already built JAR")
    parser.add_argument("--profile", help="Install only into this PyCharm profile directory name")
    args = parser.parse_args()
    if args.build_only and args.install_only:
        parser.error("--build-only and --install-only cannot be used together")
    if not args.install_only:
        build()
    if not args.build_only:
        install(args.profile)
