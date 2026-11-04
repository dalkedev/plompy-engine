from __future__ import annotations

import hashlib
import json
import zipfile

import pytest

from szpont_browser.config import BrowserError
from szpont_browser.fetch import extract_archive, verify_archive


def test_archive_checksum_and_size_fail_closed(tmp_path):
    archive = tmp_path / "browser.zip"
    archive.write_bytes(b"offline archive fixture")
    expected = {"size": archive.stat().st_size, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}
    verify_archive(archive, expected)
    with pytest.raises(BrowserError, match="SHA256"):
        verify_archive(archive, {**expected, "sha256": "0" * 64})
    with pytest.raises(BrowserError, match="size"):
        verify_archive(archive, {**expected, "size": 1})


def test_zip_extraction_rejects_path_traversal(tmp_path):
    archive = tmp_path / "browser.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("../escaped", "never write outside destination")
    with pytest.raises(BrowserError, match="unsafe archive member"):
        extract_archive(archive, tmp_path / "unpacked")
    assert not (tmp_path / "escaped").exists()


def test_offline_layout_gets_runtime_executable_permissions(tmp_path):
    archive = tmp_path / "browser.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("camoufox-bin", "fixture")
        output.writestr("application.ini", "fixture")
    destination = tmp_path / "unpacked"
    extract_archive(archive, destination)
    assert (destination / "camoufox-bin").stat().st_mode & 0o777 == 0o755
