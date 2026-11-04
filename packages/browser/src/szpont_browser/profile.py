from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Callable

from .config import BrowserError, Config, browser_environment

CAMOUFOX_VERSION = "0.5.9"
IDENTITY_ENV = re.compile(r"CAMOU_(?:CONFIG|PREFS)_\d+|FONTCONFIG_FILE")


class ProfileLock:
    """One browser process per persistent profile, including manual login."""

    def __init__(self, profile: Path):
        self.path = profile / ".szpont.lock"
        self.fd: int | None = None

    def acquire(self) -> None:
        if self.fd is not None:
            raise BrowserError("profile_locked: this process already holds the profile")
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise BrowserError("profile_locked: stop the MCP job or manual login using this profile") from None
        os.ftruncate(fd, 0)
        os.write(fd, str(os.getpid()).encode())
        self.fd = fd

    def release(self) -> None:
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None


def executable_hash(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def load_identity(config: Config, generate: Callable[[], dict]) -> dict:
    """Persist Camoufox's complete generated identity, never the process environment.

    Caller holds ProfileLock. A changed browser requires deliberate maintenance;
    silently rotating a logged-in account's fingerprint is not an upgrade policy.
    """
    path = config.profile / ".szpont-identity.json"
    digest = executable_hash(config.executable)
    if path.is_symlink():
        raise BrowserError("identity_invalid: fingerprint file must not be a symlink")
    if path.exists():
        try:
            saved = json.loads(path.read_text())
            if (saved["schema"] != 1 or saved["camoufox"] != CAMOUFOX_VERSION
                    or saved["executable_sha256"] != digest):
                raise BrowserError("identity_version_mismatch: browser changed; inspect and migrate the profile explicitly")
            options = saved["options"]
            if (set(options) != {"args", "firefox_user_prefs", "env"}
                    or not isinstance(options["args"], list)
                    or not isinstance(options["firefox_user_prefs"], dict)
                    or not isinstance(options["env"], dict)
                    or not any(key.startswith("CAMOU_CONFIG_") for key in options["env"])
                    or any(not IDENTITY_ENV.fullmatch(key) or not isinstance(value, str)
                           for key, value in options["env"].items())):
                raise ValueError("invalid identity options")
        except BrowserError:
            raise
        except (ValueError, KeyError, TypeError):
            raise BrowserError("identity_invalid: saved fingerprint could not be verified") from None
    else:
        generated = generate()
        options = {
            "args": generated.get("args", []),
            "firefox_user_prefs": generated.get("firefox_user_prefs", {}),
            "env": {key: value for key, value in generated["env"].items() if IDENTITY_ENV.fullmatch(key)},
        }
        saved = {"schema": 1, "camoufox": CAMOUFOX_VERSION, "executable_sha256": digest, "options": options}
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(saved, output, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
    fontconfig = options["env"].get("FONTCONFIG_FILE")
    if fontconfig and not Path(fontconfig).is_file():
        raise BrowserError("identity_auxiliary_missing: saved fontconfig is missing; restore its cache before launching")
    return {
        **options,
        "env": {**options["env"], **browser_environment()},
        "executable_path": str(config.executable),
        "headless": False,
        "user_data_dir": str(config.profile),
        "accept_downloads": False,
        "service_workers": "block",
        "ignore_https_errors": False,
    }
