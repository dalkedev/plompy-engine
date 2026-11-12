import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { installation } from "../../playwright/runtime.mjs";
import { safeFetch, assertPublicUrl } from "./network.mjs";

const active = new Set();
const MAX_TEXT = 100_000;
let busy = false;

export async function closeBrowser() {
  await Promise.allSettled([...active].map((browser) => browser.close()));
  active.clear();
}

/** A single read operation, not the general purpose browser MCP action surface. */
export async function readBrowserPage(url, { signal, networkOptions = {}, onBrowserForTests, onErrorForTests } = {}) {
  if (busy) throw Object.assign(new Error("The browser is busy. Try after the current read finishes."), { code: "BROWSER_BUSY" });
  signal = AbortSignal.any([AbortSignal.timeout(30_000), signal].filter(Boolean));
  busy = true;
  let browser;
  let stop;
  try {
    await assertPublicUrl(url, { ...networkOptions, signal });
    signal?.throwIfAborted();
    // Resolve ordinary HTTP redirects before navigation. Chromium can bypass a
    // route handler for redirect hops; it never receives an unvetted redirect.
    const initialResponse = await safeFetch(url, { ...networkOptions, signal, maxBytes: 1024 * 1024, followRedirects: true });
    const installed = await installation();
    const require = createRequire(pathToFileURL(installed.playwright));
    const { chromium } = require(installed.playwright);
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      timeout: 20_000,
      // Raw browser networking fails closed; intercepted requests are fulfilled by
      // safeFetch, which pins public DNS. This also blocks browser-internal bypasses.
      proxy: { server: "http://127.0.0.1:9", bypass: "<-loopback>" },
      args: ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
      env: Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "PLAYWRIGHT_BROWSERS_PATH"]
        .filter((key) => typeof process.env[key] === "string").map((key) => [key, process.env[key]])),
    });
    active.add(browser);
    await onBrowserForTests?.(browser);
    stop = () => { void browser.close().catch(() => {}); };
    signal?.addEventListener("abort", stop, { once: true });
    const context = await browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
      permissions: [],
      ignoreHTTPSErrors: false,
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });
    let requests = 0, totalBytes = 0, initialUsed = false, fetching = 0;
    const waiters = [];
    const blocked = [];
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.route("**/*", async (route) => {
      const request = route.request();
      let acquired = false;
      try {
        if (++requests > 60 || !["GET", "HEAD"].includes(request.method()) ||
            ["image", "media", "font"].includes(request.resourceType())) {
          blocked.push(request.resourceType()); await route.abort("blockedbyclient"); return;
        }
        if (request.isNavigationRequest() && (initialUsed || request.url() !== initialResponse.url)) {
          blocked.push("navigation"); await route.abort("blockedbyclient"); return;
        }
        if (fetching >= 4) await new Promise((resolve) => waiters.push(resolve));
        else fetching++;
        acquired = true;
        signal.throwIfAborted();
        if (totalBytes >= 5 * 1024 * 1024) throw new Error("budget");
        const result = request.isNavigationRequest()
          ? (initialUsed = true, initialResponse)
          : await safeFetch(request.url(), { ...networkOptions, signal, maxBytes: 1024 * 1024, method: request.method(), followRedirects: true });
        totalBytes += result.body.length;
        if (totalBytes > 5 * 1024 * 1024) throw new Error("budget");
        await route.fulfill({ status: result.status, headers: result.headers, body: result.body });
      } catch {
        blocked.push("request"); await route.abort("blockedbyclient").catch(() => {});
      } finally {
        if (acquired) {
          const next = waiters.shift();
          if (next) next(); else fetching--;
        }
      }
    });
    const page = await context.newPage();
    context.on("page", (popup) => { if (popup !== page) void popup.close().catch(() => {}); });
    page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => {}); });
    const response = await page.goto(initialResponse.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    // Bounded opportunity for client-rendered contact text. No clicks, sign-in or forms.
    await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => {});
    signal?.throwIfAborted();
    const result = await page.evaluate((limit) => {
      const text = (document.body?.innerText ?? "").slice(0, limit);
      const links = [...document.querySelectorAll("a[href]")].slice(0, 200)
        .map((link) => ({ text: (link.textContent ?? "").trim().slice(0, 200), url: link.href }))
        .filter((link) => /^(https?:|mailto:)/.test(link.url));
      const found = [...text.matchAll(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,63}/gi)]
        .map((match) => match[0]);
      for (const link of links.filter((link) => link.url.startsWith("mailto:"))) {
        try { found.push(decodeURIComponent(link.url.slice(7).split("?")[0])); } catch { /* malformed mailto */ }
      }
      const emails = [...new Set(found.map((value) => value.toLowerCase()))]
        .filter((value) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(value)).slice(0, 100)
        .map((email) => ({ email, source_url: location.href }));
      return { url: location.href, title: document.title.slice(0, 500), text, links, emails };
    }, MAX_TEXT);
    return {
      ...result,
      status: response?.status() ?? null,
      checked_at: new Date().toISOString(),
      evidence_status: "published_on_page_not_deliverability_verified",
      untrusted_content: true,
      limits: { textCharacters: MAX_TEXT, blockedRequests: blocked.length, requestCount: requests },
    };
  } catch (error) {
    onErrorForTests?.(error);
    if (["URL_BLOCKED", "DNS_FAILED", "BROWSER_BUSY"].includes(error.code)) throw error;
    throw Object.assign(new Error(signal?.aborted
      ? "The browser read was cancelled."
      : "The browser could not read this page. Verify the browser image and sandbox support; no sandbox fallback is used."),
    { code: signal?.aborted ? "BROWSER_CANCELLED" : "BROWSER_UNAVAILABLE" });
  } finally {
    if (stop) signal?.removeEventListener("abort", stop);
    if (browser) { active.delete(browser); await browser.close().catch(() => {}); }
    busy = false;
  }
}
