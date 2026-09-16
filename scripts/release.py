#!/usr/bin/env python3
"""Local release checks and packaging. This script never publishes anything."""

import argparse
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path, PurePosixPath

import tomllib

ROOT = Path(__file__).resolve().parent.parent
TARGETS = {
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
    "x86_64-pc-windows-msvc",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def release_version(root=ROOT):
    cargo = tomllib.loads((root / "Cargo.toml").read_text())
    version = cargo["package"]["version"]
    match = re.fullmatch(
        r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?",
        version,
    )
    require(match, f"Unsupported release version: {version}")
    python_version = ".".join(match.group(1, 2, 3))
    if match[4]:
        python_version += {"alpha": "a", "beta": "b", "rc": "rc"}[match[4]] + match[5]
    return version, python_version


def validate_ref(version, env):
    """A branch may rehearse a release, but only the matching tag may publish."""
    event = env.get("GITHUB_EVENT_NAME")
    if event == "workflow_dispatch" and env.get("DRY_RUN") == "true":
        return
    require(event in {"push", "workflow_dispatch"}, "Unsupported release event")
    require(
        env.get("GITHUB_REF_TYPE") == "tag",
        "Publishing requires an existing version tag",
    )
    require(env.get("GITHUB_REF_NAME") == f"v{version}", "Tag must match Cargo.toml")


def check_tree(root=ROOT):
    status = subprocess.check_output(
        ["git", "-C", str(root), "status", "--porcelain"], text=True
    )
    require(not status.strip(), "Commit source changes before packaging a release")


def metadata(github=False, clean=False):
    if clean:
        check_tree()
    version, python_version = release_version()
    for path in ["web/package.json", "web/package-lock.json"]:
        data = json.loads((ROOT / path).read_text())
        require(data["version"] == version, f"Version mismatch in {path}")
        if "packages" in data:
            require(
                data["packages"][""]["version"] == version,
                f"Root package mismatch in {path}",
            )
    lock = tomllib.loads((ROOT / "Cargo.lock").read_text())
    require(
        any(
            p["name"] == "rdfscope" and p["version"] == version for p in lock["package"]
        ),
        "Cargo.lock version mismatch",
    )
    python = tomllib.loads((ROOT / "pyproject.toml").read_text())
    require(
        python["project"]["name"] == "rdfscope"
        and "version" in python["project"]["dynamic"],
        "Python version must come from Cargo.toml",
    )
    require(
        f"## [{version}]" in (ROOT / "CHANGELOG.md").read_text(),
        "Missing changelog entry",
    )
    if github:
        validate_ref(version, os.environ)
    values = {
        "version": version,
        "python_version": python_version,
        "tag": f"v{version}",
        "prerelease": str("-" in version).lower(),
    }
    output = "".join(f"{key}={value}\n" for key, value in values.items())
    print(output, end="")
    if github:
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as handle:
            handle.write(output)


def check_source(path, version, cargo_version=None):
    with tarfile.open(path) as archive:
        members = archive.getmembers()
        require(
            all(m.isfile() or m.isdir() for m in members),
            "Unexpected link in source package",
        )
        files = {
            str(PurePosixPath(m.name).relative_to(f"rdfscope-{version}")): m
            for m in members
            if m.isfile()
        }
        for name in files:
            require(
                not name.startswith("/") and ".." not in PurePosixPath(name).parts,
                "Unsafe archive member",
            )
            require(
                not any(
                    part in {".git", ".impeccable", "node_modules", ".venv", "target"}
                    for part in PurePosixPath(name).parts
                ),
                f"Working files packaged: {name}",
            )
            require(
                not name.endswith((".rdfscope.json", ".lattice.json"))
                and name not in {"DESIGN.md", "PRODUCT.md"},
                f"Private working file packaged: {name}",
            )
        required = {
            "Cargo.toml",
            "Cargo.lock",
            "src/main.rs",
            "build.rs",
            "LICENSE",
            "README.md",
            "pyproject.toml",
            "examples/research-library.trig",
            "web/dist/index.html",
            "web/dist/THIRD_PARTY_LICENSES.txt",
        }
        require(
            required <= files.keys(),
            f"Source package missing: {sorted(required - files.keys())}",
        )
        index = archive.extractfile(files["web/dist/index.html"]).read().decode()
        assets = re.findall(r'(?:src|href)="(/[^"?#]+)', index)
        require(
            any(asset.endswith(".js") for asset in assets),
            "Missing compiled JavaScript",
        )
        for asset in assets:
            require("web/dist" + asset in files, f"Missing UI asset: {asset}")
        manifest = tomllib.loads(
            archive.extractfile(files["Cargo.toml"]).read().decode()
        )
        require(
            manifest["package"]["version"] == (cargo_version or version),
            "Source package version mismatch",
        )


def check_wheel(path):
    _, python_version = release_version()
    with zipfile.ZipFile(path) as wheel:
        names = wheel.namelist()
        binaries = [
            name
            for name in names
            if re.fullmatch(r"rdfscope-[^/]+\.data/scripts/rdfscope(?:\.exe)?", name)
        ]
        require(len(binaries) == 1, "Wheel must contain the RDFscope binary")
        metadata_text = wheel.read(
            f"rdfscope-{python_version}.dist-info/METADATA"
        ).decode()
        require(
            f"Version: {python_version}\n" in metadata_text, "Wheel version mismatch"
        )
        require("Name: rdfscope\n" in metadata_text, "Wheel name mismatch")
        require(
            "Requires-Dist:" not in metadata_text,
            "Binary wheel unexpectedly requires Python dependencies",
        )
        require(
            any(name.endswith("/LICENSE") for name in names), "Missing wheel license"
        )
        require(
            not any(".libs/" in name for name in names),
            "Standalone archive requires bundled shared libraries",
        )
        return binaries[0]


def check_artifacts(patterns):
    paths = sorted({Path(path) for pattern in patterns for path in glob.glob(pattern)})
    require(paths, "No artifacts found")
    for pattern in patterns:
        require(glob.glob(pattern), f"No artifacts match {pattern}")
    version, python_version = release_version()
    for path in paths:
        if path.suffix == ".whl":
            check_wheel(path)
        elif path.suffix == ".crate":
            check_source(path, version)
        elif path.name == f"rdfscope-{python_version}.tar.gz":
            check_source(path, python_version, version)
        else:
            raise ValueError(f"Unexpected package: {path}")
        print(f"PASS: {path}")


def archive_wheel(wheel_path, target, output):
    require(target in TARGETS, f"Unsupported target: {target}")
    member = check_wheel(wheel_path)
    version, _ = release_version()
    output.mkdir(parents=True, exist_ok=True)
    name = f"rdfscope-v{version}-{target}"
    with tempfile.TemporaryDirectory(prefix="rdfscope-archive-") as temporary:
        directory = Path(temporary)
        binary = directory / PurePosixPath(member).name
        with zipfile.ZipFile(wheel_path) as wheel:
            binary.write_bytes(wheel.read(member))
        binary.chmod(0o755)
        for filename in ["README.md", "LICENSE", "CHANGELOG.md"]:
            (directory / filename).write_bytes((ROOT / filename).read_bytes())
        (directory / "THIRD_PARTY_LICENSES.txt").write_bytes(
            (ROOT / "web/dist/THIRD_PARTY_LICENSES.txt").read_bytes()
        )
        if "windows" in target:
            path = output / f"{name}.zip"
            with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
                for file in sorted(directory.iterdir()):
                    archive.write(file, f"{name}/{file.name}")
        else:
            path = output / f"{name}.tar.gz"
            with tarfile.open(path, "w:gz") as archive:
                archive.add(directory, arcname=name)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    Path(str(path) + ".sha256").write_text(f"{digest}  {path.name}\n")
    print(path)


def smoke(binary):
    binary = binary.resolve()
    version, _ = release_version()
    actual = subprocess.check_output([str(binary), "--version"], text=True).strip()
    require(actual == f"rdfscope {version}", f"Unexpected binary version: {actual}")
    with tempfile.TemporaryDirectory(prefix="rdfscope-smoke-") as directory:
        log = Path(directory) / "server.log"
        with log.open("w") as handle:
            process = subprocess.Popen(
                [str(binary), "--no-open", "--port", "0"],
                cwd=directory,
                stdout=handle,
                stderr=subprocess.STDOUT,
            )
        try:
            deadline = time.monotonic() + 20
            url = None
            while time.monotonic() < deadline:
                contents = log.read_text(errors="replace")
                match = re.search(r"http://127\.0\.0\.1:\d+", contents)
                if match:
                    url = match[0]
                    break
                require(process.poll() is None, f"Server exited: {contents}")
                time.sleep(0.1)
            require(url, f"Server did not start: {log.read_text(errors='replace')}")
            subprocess.run(
                [sys.executable, str(ROOT / "scripts/smoke.py"), url],
                check=True,
                timeout=90,
            )
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    metadata_parser = commands.add_parser("metadata")
    metadata_parser.add_argument("--github", action="store_true")
    metadata_parser.add_argument("--clean", action="store_true")
    commands.add_parser("check-artifacts").add_argument("patterns", nargs="+")
    archive = commands.add_parser("archive")
    archive.add_argument("--wheel", type=Path, required=True)
    archive.add_argument("--target", required=True)
    archive.add_argument("--out", type=Path, default=ROOT / "dist")
    commands.add_parser("smoke").add_argument("binary", type=Path)
    args = parser.parse_args()
    if args.command == "metadata":
        metadata(args.github, args.clean)
    elif args.command == "check-artifacts":
        check_artifacts(args.patterns)
    elif args.command == "archive":
        archive_wheel(args.wheel, args.target, args.out)
    elif args.command == "smoke":
        smoke(args.binary)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
