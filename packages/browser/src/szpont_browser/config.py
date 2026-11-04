from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


class BrowserError(RuntimeError):
    """An actionable browser error, safe for the local MCP caller."""


@dataclass(frozen=True)
class Config:
    profile: Path
    artifacts: Path
    executable: Path

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Config:
        env = os.environ if env is None else env
        paths = {
            "profile": env.get("SZPONT_BROWSER_PROFILE", "/var/lib/szpont/browser"),
            "artifacts": env.get("SZPONT_BROWSER_ARTIFACTS", "/var/lib/szpont/artifacts/browser"),
            "executable": env.get("CAMOUFOX_EXECUTABLE_PATH", ""),
        }
        for name, value in paths.items():
            if not value or not Path(value).is_absolute() or Path(value) == Path("/"):
                raise BrowserError(f"configuration_error: {name} must be an absolute non-root path")
        result = cls(**{key: Path(value).resolve() for key, value in paths.items()})
        if (result.profile == result.artifacts or result.profile in result.artifacts.parents
                or result.artifacts in result.profile.parents):
            raise BrowserError("configuration_error: profile and artifacts must not overlap")
        return result

    def prepare(self) -> None:
        if not self.executable.is_file() or not os.access(self.executable, os.X_OK):
            raise BrowserError("browser_not_installed: CAMOUFOX_EXECUTABLE_PATH must name the provisioned executable")
        for path in (self.profile, self.artifacts):
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
            path.chmod(0o700)


def browser_environment(env: Mapping[str, str] | None = None) -> dict[str, str]:
    """Do not pass Codex/API credentials into the browser child process."""
    env = os.environ if env is None else env
    names = ("PATH", "HOME", "DISPLAY", "XAUTHORITY", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "LANG", "LC_ALL", "TZ")
    result = {key: env[key] for key in names if key in env}
    result.update({"GDK_BACKEND": "x11", "MOZ_ENABLE_WAYLAND": "0"})
    return result
