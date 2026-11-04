"""Root provisioning helper for the exact reviewed Linux x86_64 Camoufox archive.

This is deliberately separate from runtime launch and never runs via an MCP tool.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import stat
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

from .config import BrowserError


def verify_archive(archive: Path, manifest: dict) -> None:
    if archive.stat().st_size != manifest["size"]:
        raise BrowserError("browser_archive_invalid: archive size does not match the reviewed build")
    with archive.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != manifest["sha256"]:
        raise BrowserError("browser_archive_invalid: archive SHA256 does not match the reviewed build")


def extract_archive(archive: Path, destination: Path) -> None:
    destination.mkdir(mode=0o755)
    destination.chmod(0o755)
    with zipfile.ZipFile(archive) as source:
        for entry in source.infolist():
            target = (destination / entry.filename).resolve()
            if (target != destination.resolve() and destination.resolve() not in target.parents
                    or Path(entry.filename).is_absolute()
                    or stat.S_ISLNK(entry.external_attr >> 16)):
                raise BrowserError("browser_archive_invalid: unsafe archive member")
            source.extract(entry, destination)
            target.chmod(0o755)
    for path in destination.rglob("*"):
        if path.is_dir():
            path.chmod(0o755)
    if not (destination / "camoufox-bin").is_file() or not (destination / "application.ini").is_file():
        raise BrowserError("browser_archive_invalid: expected Camoufox executable and metadata are absent")


def _create_install_parents(directory: Path) -> None:
    try:
        directory.mkdir(mode=0o755)
    except FileNotFoundError:
        _create_install_parents(directory.parent)
        _create_install_parents(directory)
    except FileExistsError:
        if not directory.is_dir():
            raise
    else:
        # mkdir's mode is filtered by root's umask. Only change directories this
        # invocation created; existing ancestors may intentionally be private.
        directory.chmod(0o755)


def install(manifest_path: Path, destination: Path, existing_archive: Path | None = None) -> dict:
    if sys.platform != "linux" or platform.machine() not in {"x86_64", "AMD64"}:
        raise BrowserError("unsupported_platform: pinned archive requires Linux x86_64")
    if os.geteuid() != 0:
        raise BrowserError("provisioning_requires_root: runtime service must not install browser binaries")
    manifest = json.loads(manifest_path.read_text())
    if (manifest.get("platform") != "linux-x86_64" or manifest.get("camoufox_python") != "0.5.9"
            or not str(manifest.get("url", "")).startswith("https://github.com/daijro/camoufox/releases/download/")
            or not isinstance(manifest.get("size"), int) or manifest["size"] <= 0
            or len(str(manifest.get("sha256", ""))) != 64):
        raise BrowserError("browser_manifest_invalid: expected the reviewed official build manifest")
    if not destination.is_absolute() or destination == Path("/") or destination.exists():
        raise BrowserError("destination_exists: choose a new absolute browser version directory")
    _create_install_parents(destination.parent)
    with tempfile.TemporaryDirectory(prefix=".szpont-browser-", dir=destination.parent) as temporary:
        stage = Path(temporary)
        archive = existing_archive or stage / "browser.zip"
        if existing_archive is None:
            count = 0
            request = urllib.request.Request(manifest["url"], headers={"User-Agent": "Szpont-Provisioner/0.1"})
            with urllib.request.urlopen(request, timeout=120) as source, archive.open("wb") as output:
                while chunk := source.read(1024 * 1024):
                    count += len(chunk)
                    if count > manifest["size"]:
                        raise BrowserError("browser_archive_invalid: archive exceeded reviewed size")
                    output.write(chunk)
        verify_archive(archive, manifest)
        unpacked = stage / "unpacked"
        extract_archive(archive, unpacked)
        receipt = {"version": manifest["version"], "archive_sha256": manifest["sha256"],
                   "archive_size": archive.stat().st_size, "source_url": manifest["url"], "verified": True}
        (unpacked / ".szpont-build.json").write_text(json.dumps(receipt, indent=2) + "\n")
        (unpacked / ".szpont-build.json").chmod(0o644)
        os.rename(unpacked, destination)
    return {**receipt, "executable": str(destination / "camoufox-bin")}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--archive", type=Path, help="Optional predownloaded archive; always verifies pinned size and SHA256")
    args = parser.parse_args()
    print(json.dumps(install(args.manifest, args.destination, args.archive), indent=2))


if __name__ == "__main__":
    main()
