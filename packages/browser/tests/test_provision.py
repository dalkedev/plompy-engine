from __future__ import annotations

import hashlib
import json
import os
import stat
import zipfile

import pytest

from plompy_browser.config import BrowserError
from plompy_browser.fetch import extract_archive, install, verify_archive


@pytest.fixture
def restrictive_umask():
    previous = os.umask(0o077)
    try:
        yield
    finally:
        os.umask(previous)


@pytest.fixture
def offline_install(tmp_path, monkeypatch):
    archive = tmp_path / "browser.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("camoufox-bin", "offline executable fixture")
        output.writestr("application.ini", "offline metadata fixture")
        output.writestr("browser/components/component.bin", "offline component fixture")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({
        "platform": "linux-x86_64", "camoufox_python": "0.5.9", "version": "offline-fixture",
        "url": "https://github.com/daijro/camoufox/releases/download/offline-fixture/browser.zip",
        "size": archive.stat().st_size, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
    }))
    monkeypatch.setattr("plompy_browser.fetch.sys.platform", "linux")
    monkeypatch.setattr("plompy_browser.fetch.platform.machine", lambda: "x86_64")
    monkeypatch.setattr("plompy_browser.fetch.os.geteuid", lambda: 0)

    def reject_download(*args, **kwargs):
        pytest.fail("offline provisioning must not download an archive")

    monkeypatch.setattr("plompy_browser.fetch.urllib.request.urlopen", reject_download)
    return manifest, archive


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


def test_offline_layout_gets_runtime_executable_permissions(tmp_path, restrictive_umask):
    archive = tmp_path / "browser.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("camoufox-bin", "fixture")
        output.writestr("application.ini", "fixture")
        output.writestr("browser/components/component.bin", "fixture")
    destination = tmp_path / "unpacked"
    extract_archive(archive, destination)
    for path in (destination, *destination.rglob("*")):
        assert stat.S_IMODE(path.stat().st_mode) == 0o755


def test_install_is_traversable_after_atomic_rename_with_restrictive_umask(
    tmp_path, offline_install, restrictive_umask,
):
    manifest, archive = offline_install
    shared_parent = tmp_path / "shared"
    shared_parent.mkdir()
    shared_parent.chmod(0o755)
    destination = shared_parent / "browser" / "versions" / "offline-fixture"

    receipt = install(manifest, destination, archive)

    assert receipt["executable"] == str(destination / "camoufox-bin")
    assert receipt["verified"] is True
    # A runtime account outside the installer's owner/group needs every directory's
    # other-execute bit, including the renamed extraction root and new parents.
    directories = [shared_parent, shared_parent / "browser", destination.parent,
                   destination, destination / "browser", destination / "browser/components"]
    for directory in directories:
        assert stat.S_IMODE(directory.stat().st_mode) == 0o755
        assert directory.stat().st_mode & stat.S_IXOTH
    assert (destination / "camoufox-bin").stat().st_mode & stat.S_IXOTH
    assert (destination / "application.ini").stat().st_mode & stat.S_IROTH
    assert stat.S_IMODE((destination / ".plompy-build.json").stat().st_mode) == 0o644
    assert not list(shared_parent.rglob(".plompy-browser-*"))


def test_install_preserves_existing_private_parent_permissions(
    tmp_path, offline_install, restrictive_umask,
):
    manifest, archive = offline_install
    private_parent = tmp_path / "private"
    private_parent.mkdir(mode=0o700)
    destination = private_parent / "browser" / "offline-fixture"

    install(manifest, destination, archive)

    assert stat.S_IMODE(private_parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(destination.parent.stat().st_mode) == 0o755
    assert stat.S_IMODE(destination.stat().st_mode) == 0o755
