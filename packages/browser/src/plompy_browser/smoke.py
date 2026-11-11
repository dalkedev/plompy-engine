"""Provisioning smoke test. Opens a public page and saves a screenshot; no account actions."""
from __future__ import annotations

import argparse
import asyncio
import json
import hashlib

from .browser import BrowserSession
from .config import Config
from .profile import identity_path


async def run(url: str) -> dict:
    session = BrowserSession(Config.from_env())
    identity_file = identity_path(session.config.profile)
    reused = identity_file.exists()
    try:
        opened = await session.open(url)
        snapshot = await session.snapshot(opened["tab"])
        _, screenshot = await session.screenshot(opened["tab"])
        return {"ok": True, **opened, "snapshot_elements": len(snapshot["elements"]),
                "snapshot_characters": len(snapshot["text"]), "screenshot": screenshot,
                "identity_reused": reused, "identity_file_sha256": hashlib.sha256(identity_file.read_bytes()).hexdigest(),
                "note": "Verifies browser launch/navigation only; no owner account was tested."}
    finally:
        await session.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="https://example.com")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(run(args.url)), indent=2))


if __name__ == "__main__":
    main()
