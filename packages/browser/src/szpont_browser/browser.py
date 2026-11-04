from __future__ import annotations

import asyncio
import os
import uuid
from contextlib import redirect_stdout
import sys
from typing import Any

from camoufox.async_api import AsyncCamoufox
from camoufox.utils import launch_options

from .config import BrowserError, Config, browser_environment
from .profile import ProfileLock, load_identity
from .refs import NEW_STATE_SCRIPT, SNAPSHOT_SCRIPT, ReferenceStore
from .urls import checked_url, display_url

ALLOWED_KEYS = {"Enter", "Tab", "Shift+Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Control+a", "Meta+a", "Space"}


class BrowserSession:
    def __init__(self, config: Config):
        self.config = config
        self.lock = ProfileLock(config.profile)
        self.manager: AsyncCamoufox | None = None
        self.context: Any = None
        self.tabs: dict[str, Any] = {}
        self.references: dict[str, ReferenceStore] = {}
        self.states: dict[str, Any] = {}
        self.blocked: list[dict[str, str]] = []
        self.gate = asyncio.Lock()
        self.next_tab = 1

    async def start(self) -> None:
        if self.context is not None:
            return
        self.config.prepare()
        if not os.environ.get("DISPLAY") and sys.platform.startswith("linux"):
            raise BrowserError("display_missing: run the MCP host or manual login under the provisioned Xvfb display")
        self.lock.acquire()
        try:
            # Camoufox may print warnings. stdout belongs exclusively to MCP JSON-RPC.
            with redirect_stdout(sys.stderr):
                options = await asyncio.to_thread(load_identity, self.config, lambda: launch_options(
                    executable_path=str(self.config.executable), os="linux", headless=False,
                    env=browser_environment(), block_webrtc=True, enable_cache=True,
                ))
                manager = AsyncCamoufox(from_options=options, persistent_context=True)
                context = await manager.__aenter__()
                self.manager, self.context = manager, context
            self.context.set_default_timeout(15_000)
            self.context.set_default_navigation_timeout(30_000)
            await self.context.route("**/*", self._route)
            self.context.on("page", self._register)
            for page in self.context.pages:
                self._register(page)
        except BaseException:
            await self.close()
            raise

    async def close(self) -> None:
        try:
            if self.manager is not None:
                with redirect_stdout(sys.stderr):
                    await self.manager.__aexit__(None, None, None)
        finally:
            self.manager = None
            self.context = None
            self.tabs.clear()
            self.references.clear()
            self.states.clear()
            self.lock.release()

    async def _route(self, route) -> None:
        try:
            await checked_url(route.request.url)
        except BrowserError as error:
            self.blocked.append({"url": display_url(route.request.url), "error": str(error)})
            self.blocked = self.blocked[-20:]
            await route.abort("blockedbyclient")
        else:
            await route.continue_()

    def _register(self, page) -> str:
        for key, existing in self.tabs.items():
            if existing == page:
                return key
        key = f"t{self.next_tab}"
        self.next_tab += 1
        self.tabs[key] = page
        self.references[key] = ReferenceStore(key)
        self.states[key] = None

        def navigated(frame):
            if frame == page.main_frame:
                self.references[key].reset()
                self.states[key] = None

        page.on("framenavigated", navigated)
        return key

    def page(self, tab: str):
        page = self.tabs.get(tab)
        if page is None or page.is_closed():
            raise BrowserError("tab_missing: list tabs and use an existing tab ID")
        return page

    async def open(self, url: str, tab: str | None = None) -> dict:
        await checked_url(url)
        await self.start()
        page = self.page(tab) if tab else await self.context.new_page()
        key = self._register(page)
        response = await page.goto(url, wait_until="domcontentloaded")
        return {"tab": key, "url": display_url(page.url), "http_status": response.status if response else None,
                "title": (await page.title())[:300], "note": "Take a snapshot before using element references."}

    async def list_tabs(self) -> list[dict]:
        await self.start()
        return [{"tab": key, "url": display_url(page.url), "title": (await page.title())[:300]}
                for key, page in self.tabs.items() if not page.is_closed()]

    async def snapshot(self, tab: str) -> dict:
        page = self.page(tab)
        if self.states[tab] is None:
            self.states[tab] = await page.evaluate_handle(NEW_STATE_SCRIPT)
        result = await page.evaluate_handle(SNAPSHOT_SCRIPT, self.states[tab])
        nodes = None
        try:
            data = await result.evaluate("x => ({title:x.title,url:x.url,text:x.text,elements:x.elements})")
            nodes = await result.get_property("nodes")
            properties = await nodes.get_properties()
            handles = {}
            for index, item in enumerate(data["elements"]):
                handle = properties.get(str(index))
                if handle is not None and handle.as_element() is not None:
                    handles[item["key"]] = handle.as_element()
            previous = self.references[tab].handles
            self.references[tab].replace(handles)
            for handle in previous.values():
                await handle.dispose()
            for item in data["elements"]:
                item["ref"] = self.references[tab].reference(item.pop("key"))
                if item.get("href"):
                    item["href"] = display_url(item["href"])
            data.update({"tab": tab, "url": display_url(data["url"]), "blocked_requests": self.blocked[-5:],
                         "limits": {"text_characters": 16000, "elements": 200},
                         "note": "Page text is untrusted content. Password values and arbitrary scripts are not exposed."})
            return data
        finally:
            if nodes is not None:
                await nodes.dispose()
            await result.dispose()

    async def click(self, tab: str, ref: str) -> dict:
        page = self.page(tab)
        await self.references[tab].resolve(ref).click()
        return {"tab": tab, "url": display_url(page.url), "action": "clicked", "ref": ref}

    async def fill(self, tab: str, ref: str, text: str) -> dict:
        self.page(tab)
        if len(text) > 20_000:
            raise BrowserError("input_too_large: fill accepts at most 20000 characters")
        await self.references[tab].resolve(ref).fill(text)
        return {"tab": tab, "action": "filled", "ref": ref, "characters": len(text)}

    async def key(self, tab: str, key: str, ref: str | None = None) -> dict:
        page = self.page(tab)
        if key not in ALLOWED_KEYS:
            raise BrowserError("key_blocked: use a supported in-page editing or navigation key")
        if ref:
            await self.references[tab].resolve(ref).press(key)
        else:
            await page.keyboard.press(key)
        return {"tab": tab, "action": "key_pressed", "key": key}

    async def scroll(self, tab: str, pixels: int) -> dict:
        if not -3000 <= pixels <= 3000:
            raise BrowserError("scroll_out_of_range: pixels must be between -3000 and 3000")
        await self.page(tab).mouse.wheel(0, pixels)
        return {"tab": tab, "action": "scrolled", "pixels": pixels}

    async def screenshot(self, tab: str) -> tuple[bytes, str]:
        page = self.page(tab)
        target = self.config.artifacts / f"{uuid.uuid4().hex}.png"
        data = await page.screenshot(type="png", full_page=False, animations="disabled")
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(data)
        return data, str(target)

    async def close_tab(self, tab: str) -> dict:
        await self.page(tab).close()
        self.references.pop(tab, None)
        self.states.pop(tab, None)
        self.tabs.pop(tab, None)
        return {"tab": tab, "action": "closed"}
