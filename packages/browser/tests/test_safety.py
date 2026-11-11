from __future__ import annotations

import json
import os
import socket
import sys
from pathlib import Path

import pytest

from plompy_browser.config import BrowserError, Config, browser_environment
from plompy_browser.profile import ProfileLock, load_identity
from plompy_browser.refs import ReferenceStore
from plompy_browser.urls import checked_url, display_url, parse_public_url, public_address


@pytest.fixture
def config(tmp_path):
    executable = tmp_path / "browser"
    executable.write_bytes(b"unit-test executable fixture, never launch")
    executable.chmod(0o700)
    result = Config(tmp_path / "profile", tmp_path / "artifacts", executable)
    result.prepare()
    return result


@pytest.mark.parametrize("url", [
    "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hello", "https://user:pass@example.com/",
    "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/",
    "http://10.1.2.3/", "http://192.168.1.1/", "http://[::ffff:127.0.0.1]/",
    "http://224.0.0.1/", "https://localhost/", "https://server.internal/", "https://example.com:22/",
    "https://example.com\\@127.0.0.1/", "https://exa mple.com/", "http://2130706433/",
])
def test_unsafe_navigation_rejected_before_browser_start(url):
    with pytest.raises(BrowserError, match="url_blocked"):
        parse_public_url(url)


def test_public_https_parsing_and_redacted_display():
    assert parse_public_url("https://example.com/path?q=one")[1:] == ("example.com", 443)
    assert display_url("https://user:password@example.com/path?token=secret#code") == "https://example.com/path"
    assert public_address("93.184.216.34")
    assert not public_address("100.64.0.1")


async def test_public_hostname_with_private_or_mixed_dns_is_rejected():
    async def resolver(*_args, **_kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in ["93.184.216.34", "127.0.0.1"]]
    with pytest.raises(BrowserError, match="DNS includes"):
        await checked_url("https://example.com", resolver)


async def test_dns_error_is_visible_and_not_treated_as_public():
    async def resolver(*_args, **_kwargs):
        raise OSError("DNS fixture failure")
    with pytest.raises(BrowserError, match="dns_unavailable"):
        await checked_url("https://example.com", resolver)


async def test_public_dns_is_accepted():
    async def resolver(*_args, **_kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]
    assert await checked_url("https://example.com", resolver) == "https://example.com"


def test_profile_lock_is_exclusive_and_released(config):
    one, two = ProfileLock(config.profile), ProfileLock(config.profile)
    one.acquire()
    try:
        with pytest.raises(BrowserError, match="profile_locked"):
            two.acquire()
    finally:
        one.release()
    two.acquire()
    two.release()
    assert (config.profile / ".plompy.lock").stat().st_mode & 0o777 == 0o600


def test_profile_lock_rejects_symlink(config):
    target = config.profile / "target"
    target.touch()
    (config.profile / ".plompy.lock").symlink_to(target)
    with pytest.raises(OSError):
        ProfileLock(config.profile).acquire()


def test_identity_reused_exactly_without_persisting_process_secrets(config, monkeypatch):
    monkeypatch.setenv("CODEX_API_KEY", "never-persist-this-secret")
    generated = {"args": ["-safe-mode"], "firefox_user_prefs": {"example.pref": True},
                 "env": {"CAMOU_CONFIG_1": '{"navigator.userAgent":"generated-by-camoufox"}',
                         "CAMOU_PREFS_1": '{}', "CODEX_API_KEY": "never-persist-this-secret", "DISPLAY": ":1"}}
    first = load_identity(config, lambda: generated)
    def must_not_generate():
        raise AssertionError("fingerprint rotated")
    second = load_identity(config, must_not_generate)
    assert first == second
    assert first["headless"] is False and first["accept_downloads"] is False
    assert first["user_data_dir"] == str(config.profile)
    text = (config.profile / ".plompy-identity.json").read_text()
    assert "never-persist" not in text and '"DISPLAY"' not in text
    assert "CODEX_API_KEY" not in first["env"]
    assert (config.profile / ".plompy-identity.json").stat().st_mode & 0o777 == 0o600


def test_changed_browser_cannot_silently_reuse_or_rotate_fingerprint(config):
    load_identity(config, lambda: {"env": {"CAMOU_CONFIG_1": "{}"}})
    config.executable.write_bytes(b"different binary")
    with pytest.raises(BrowserError, match="identity_version_mismatch"):
        load_identity(config, lambda: {"env": {"CAMOU_CONFIG_1": "{}"}})


def test_invalid_identity_fails_closed(config):
    (config.profile / ".plompy-identity.json").write_text('{"unexpected":"data"}')
    with pytest.raises(BrowserError, match="identity_invalid"):
        load_identity(config, lambda: {})


def test_reference_ids_stay_stable_for_observed_nodes_and_invalidate_on_navigation():
    refs = ReferenceStore("t1")
    node = object()
    refs.replace({"e1": node})
    reference = refs.reference("e1")
    assert refs.resolve(reference) is node
    refs.replace({"e1": node, "e2": object()})
    assert refs.resolve(reference) is node
    with pytest.raises(BrowserError, match="reference_stale"):
        refs.resolve("t2-d1-e1")
    refs.reset()
    refs.replace({"e1": object()})
    with pytest.raises(BrowserError, match="reference_stale"):
        refs.resolve(reference)


def test_config_requires_explicit_executable_and_nonoverlapping_absolute_state_paths(config):
    with pytest.raises(BrowserError, match="executable"):
        Config.from_env({})
    with pytest.raises(BrowserError, match="overlap"):
        Config.from_env({"CAMOUFOX_EXECUTABLE_PATH": str(config.executable),
                         "PLOMPY_BROWSER_PROFILE": str(config.profile),
                         "PLOMPY_BROWSER_ARTIFACTS": str(config.profile / "artifacts")})
    assert Config.from_env({"CAMOUFOX_EXECUTABLE_PATH": str(config.executable)}).profile.is_absolute()


def test_browser_environment_does_not_inherit_credentials():
    env = browser_environment({"PATH": "/usr/bin", "DISPLAY": ":1", "HOME": "/var/lib/plompy", "PLOMPY_API_TOKEN": "secret", "OPENAI_API_KEY": "secret"})
    assert env["DISPLAY"] == ":1"
    assert set(env) == {"PATH", "DISPLAY", "HOME", "GDK_BACKEND", "MOZ_ENABLE_WAYLAND"}


@pytest.mark.parametrize("module,prefix", [("plompy_browser", "PLOMPY"), ("szpont_browser", "SZPONT")])
async def test_official_mcp_stdio_discovers_tools_and_reports_blocked_navigation_without_launch(config, module, prefix):
    from mcp import Client
    from mcp.client.stdio import StdioServerParameters
    parameters = StdioServerParameters(command=sys.executable, args=["-m", module], env={
        "PATH": os.environ["PATH"], "CAMOUFOX_EXECUTABLE_PATH": str(config.executable),
        f"{prefix}_BROWSER_PROFILE": str(config.profile), f"{prefix}_BROWSER_ARTIFACTS": str(config.artifacts),
    })
    async with Client(parameters) as client:
        tools = await client.list_tools()
        assert {tool.name for tool in tools.tools} == {
            "browser_open", "browser_tabs", "browser_snapshot", "browser_click", "browser_fill",
            "browser_key", "browser_scroll", "browser_screenshot", "browser_close_tab",
        }
        result = await client.call_tool("browser_open", {"url": "http://127.0.0.1"})
        assert "url_blocked" in json.dumps(result.model_dump(mode="json"))
    assert not (config.profile / ".plompy-identity.json").exists()


def test_legacy_environment_aliases_preserve_profiles_and_new_values_win(config):
    env = {"CAMOUFOX_EXECUTABLE_PATH": str(config.executable),
           "SZPONT_BROWSER_PROFILE": str(config.profile),
           "SZPONT_BROWSER_ARTIFACTS": str(config.artifacts)}
    assert Config.from_env(env) == config
    replacement = str(config.profile.parent / "explicit-profile")
    assert Config.from_env({**env, "PLOMPY_BROWSER_PROFILE": replacement}).profile == Path(replacement)
    with pytest.raises(BrowserError, match="profile"):
        Config.from_env({**env, "PLOMPY_BROWSER_PROFILE": ""})


def test_legacy_identity_is_reused_without_rotation_and_ambiguity_is_rejected(config):
    from plompy_browser.profile import identity_path
    first = load_identity(config, lambda: {"env": {"CAMOU_CONFIG_1": "persisted-identity"}})
    current = config.profile / ".plompy-identity.json"
    legacy = config.profile / ".szpont-identity.json"
    current.rename(legacy)
    before = legacy.read_bytes()
    def must_not_generate():
        raise AssertionError("legacy fingerprint rotated")
    assert load_identity(config, must_not_generate) == first
    assert identity_path(config.profile) == legacy
    assert legacy.read_bytes() == before
    assert not current.exists()
    current.write_bytes(before)
    with pytest.raises(BrowserError, match="both current and legacy"):
        load_identity(config, must_not_generate)


def test_new_browser_lock_excludes_legacy_process_and_releases_after_failure(config):
    import fcntl
    fd = os.open(config.profile / ".szpont.lock", os.O_RDWR | os.O_CREAT, 0o600)
    lock = ProfileLock(config.profile)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(BrowserError, match="profile_locked"):
            lock.acquire()
    finally:
        os.close(fd)
    lock.acquire()
    try:
        fd = os.open(config.profile / ".szpont.lock", os.O_RDWR)
        with pytest.raises(BlockingIOError):
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.close(fd)
    finally:
        lock.release()


def test_legacy_python_namespace_remains_available_without_launch():
    from szpont_browser import __version__ as legacy_version
    from plompy_browser import __version__
    from szpont_browser.config import Config as LegacyConfig
    assert legacy_version == __version__
    assert callable(LegacyConfig.from_env)
