#!/usr/bin/env python3
"""Append Rust dependency notices to the browser distribution."""

import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
metadata = json.loads(
    subprocess.check_output(
        [
            "cargo",
            "metadata",
            "--manifest-path",
            str(ROOT / "browser/Cargo.toml"),
            "--format-version",
            "1",
            "--locked",
            "--filter-platform",
            "wasm32-unknown-unknown",
        ],
        text=True,
    )
)
resolved = {node["id"] for node in metadata["resolve"]["nodes"]}
notices = ["\nRust dependencies used to build the browser RDF engine\n"]
for package in sorted(metadata["packages"], key=lambda p: (p["name"], p["version"])):
    if package["id"] not in resolved or package["source"] is None:
        continue
    directory = Path(package["manifest_path"]).parent
    files = [
        p
        for p in directory.iterdir()
        if p.is_file()
        and re.match(
            r"^(license|licence|copying|notice|copyright)([.-]|$)",
            p.name,
            re.IGNORECASE,
        )
    ]
    if package["license_file"]:
        files.append(directory / package["license_file"])
    if (
        not files
        and (package["repository"] or "").startswith(
            "https://github.com/oxigraph/oxigraph/"
        )
        and package["license"] == "MIT OR Apache-2.0"
    ):
        files.append(ROOT / "browser/licenses/Oxigraph-MIT.txt")
    if not files:
        raise SystemExit(f"Missing license notices for {package['name']}")
    notices.append(f"\n{package['name']} {package['version']} ({package['license']})\n")
    for file in sorted(set(files)):
        notices.append(file.read_text())
with (ROOT / "web/dist-browser/THIRD_PARTY_LICENSES.txt").open("a") as output:
    output.write("\n".join(notices))
