"""Owner-operated headed login, using the exact MCP profile and identity."""
from __future__ import annotations

import argparse
import asyncio
import sys

from .browser import BrowserSession
from .config import Config


async def run(url: str | None) -> None:
    session = BrowserSession(Config.from_env())
    try:
        await session.start()
        if url:
            await session.open(url)
        elif not session.context.pages:
            await session.context.new_page()
        print("Manual browser ready. Use the private VNC session to sign in yourself.\n"
              "No credentials are requested or read by this helper. Close account dialogs,\n"
              "then press Enter in this terminal to save the profile and close the browser.", file=sys.stderr)
        await asyncio.to_thread(input)
    finally:
        await session.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", help="Optional explicit public HTTP(S) page to open")
    args = parser.parse_args()
    try:
        asyncio.run(run(args.url))
    except (EOFError, KeyboardInterrupt):
        pass


if __name__ == "__main__":
    main()
