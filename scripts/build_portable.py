"""Build and smoke-test a self-contained Windows x64 ZIP from this working tree."""

from __future__ import annotations

import importlib.metadata
import os
import platform
import shutil
import struct
import subprocess
import sys
import tempfile
import tomllib
import zipfile
from pathlib import Path
from urllib.request import urlopen

from check_portable import check_portable


ROOT = Path(__file__).resolve().parents[1]
DECODER_URL = "https://github.com/vgmstream/vgmstream/releases/download/r2168/vgmstream-win64.zip"


def run(*args: str):
    subprocess.run(args, cwd=ROOT, check=True)


def prepare_assets():
    npm = shutil.which("npm.cmd")
    if not npm:
        raise RuntimeError("Building requires Node.js/npm. Install it, then run Build Portable.cmd again.")
    print("Installing the locked browser dependency...", flush=True)
    run(npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund")

    decoder = ROOT / ".tools/vgmstream"
    if not (decoder / "vgmstream-cli.exe").is_file():
        print("Downloading the Rocksmith audio decoder...", flush=True)
        decoder.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="decoder-", dir=decoder.parent) as temp:
            archive = Path(temp) / "vgmstream.zip"
            with urlopen(DECODER_URL, timeout=60) as source, archive.open("wb") as target:
                shutil.copyfileobj(source, target)
            with zipfile.ZipFile(archive) as package:
                package.extractall(Path(temp) / "unpacked")
            # Retain the official distribution, including its DLLs and notices.
            shutil.copytree(Path(temp) / "unpacked", decoder, dirs_exist_ok=True)
    required = [
        decoder / "vgmstream-cli.exe", decoder / "COPYING",
        ROOT / "node_modules/three/build/three.module.js",
        ROOT / "node_modules/three/build/three.core.js", ROOT / "node_modules/three/LICENSE",
    ]
    for file in required:
        if not file.is_file():
            raise RuntimeError(f"Missing build asset: {file}")


def copy_licenses(bundle: Path):
    licenses = bundle / "licenses"
    licenses.mkdir()
    shutil.copy2(ROOT / "node_modules/three/LICENSE", licenses / "Three.js.txt")
    shutil.copy2(ROOT / "LICENSE-RS2IR.txt", licenses / "RS2IR.txt")
    shutil.copy2(Path(sys.base_prefix) / "LICENSE.txt", licenses / "Python.txt")
    for name in ("pillow", "pycryptodome"):
        distribution = importlib.metadata.distribution(name)
        notices = [f for f in distribution.files or []
                   if "license" in f.name.lower() or "copying" in f.name.lower()]
        if not notices:
            raise RuntimeError(f"No license found for {name}.")
        for notice in notices:
            destination = licenses / name / Path(*notice.parts[1:])
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(distribution.locate_file(notice), destination)


def main():
    if sys.platform != "win32" or struct.calcsize("P") != 8 or platform.machine().lower() not in ("amd64", "x86_64"):
        raise RuntimeError("Build this Windows x64 package using 64-bit Python on Windows x64.")
    version = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    prepare_assets()
    build_root, dist_root = ROOT / "build", ROOT / "dist"
    build_root.mkdir(exist_ok=True)
    dist_root.mkdir(exist_ok=True)
    output = dist_root / f"TabPlayer-{version}-windows-x64.zip"

    # A fresh staging folder prevents personal data or previous builds leaking in.
    with tempfile.TemporaryDirectory(prefix="portable-", dir=build_root) as temporary:
        staging = Path(temporary)
        command = [
            sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
            "--onedir", "--console", "--noupx", "--name", "TabPlayer",
            "--distpath", str(staging / "dist"), "--workpath", str(staging / "work"),
            "--specpath", str(staging), "--paths", str(ROOT),
            # Calibration tools and their optional scientific stack are not runtime dependencies.
            "--exclude-module", "numpy", "--exclude-module", "tkinter",
        ]
        assets = [
            (ROOT / "static", "static"),
            (ROOT / "scripts/pick_folder.ps1", "scripts"),
            (ROOT / "node_modules/three/build/three.module.js", "node_modules/three/build"),
            (ROOT / "node_modules/three/build/three.core.js", "node_modules/three/build"),
            (ROOT / ".tools/vgmstream", ".tools/vgmstream"),
        ]
        for source, destination in assets:
            command.extend(("--add-data", f"{source}:{destination}"))
        print("Building TabPlayer.exe...", flush=True)
        run(*command, str(ROOT / "server.py"))
        bundle = staging / "dist/TabPlayer"
        for file in (ROOT / "scripts/portable").iterdir():
            shutil.copy2(file, bundle / file.name)
        shutil.copy2(ROOT / "THIRD_PARTY.md", bundle / "THIRD_PARTY.md")
        copy_licenses(bundle)

        archive = staging / output.name
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as package:
            for file in sorted(bundle.rglob("*")):
                if file.is_file():
                    package.write(file, file.relative_to(bundle.parent))
        print("Checking the extracted ZIP without development tools on PATH...", flush=True)
        check_portable(archive, staging / "smoke", [p.name for p in (ROOT / "static").iterdir() if p.is_file()])
        # Publish only after checks pass; a failed rebuild preserves the previous ZIP.
        os.replace(archive, output)

    print(f"\nReady to share: {output}\nSize: {output.stat().st_size / (1024 ** 2):.1f} MiB", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        print(f"\nBuild failed: {error}", file=sys.stderr)
        sys.exit(1)
