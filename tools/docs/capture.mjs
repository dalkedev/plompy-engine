import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const output = join(root, "assets/screenshots");
const modes = [
  [
    "session",
    "One thread. The same session.",
    "Follow up with context; keep separate conversations separate.",
  ],
  [
    "recovery",
    "Interrupted work stays visible.",
    "Inspect the saved result, then choose whether to recover.",
  ],
  [
    "providers",
    "Your CLI. Your session.",
    "Provider-bound work keeps its identity when defaults change.",
  ],
];
const escape = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor !== 26 || nodeMinor < 13)
  throw new Error("Use Node 26.13.0 or newer within Node 26 for documentation captures.");
const logo = `data:image/png;base64,${(await readFile(join(root, "assets/brand/logo.png"))).toString("base64")}`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLOMPY_CAPTURE_BROWSER
    ? { executablePath: process.env.PLOMPY_CAPTURE_BROWSER }
    : { channel: "chromium" }),
});
try {
  for (const [mode, title, subtitle] of modes) {
    const result = await execute(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "scripts/demo.mjs", mode],
      {
        cwd: root,
        timeout: 15_000,
        maxBuffer: 65_536,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: "C.UTF-8",
          NO_COLOR: "1",
        },
      },
    );
    const transcript = result.stdout.trim();
    if (!transcript.includes("synthetic") || !transcript.includes("no model"))
      throw new Error("Demo provenance label missing.");
    await writeFile(join(output, `${mode}.txt`), transcript + "\n");
    const lines = transcript
      .split("\n")
      .map(
        (line) =>
          `<div class="line ${/^(owner|>)/i.test(line) ? "owner" : /^(check|pass|verify|state|evidence)/i.test(line) ? "state" : /^#/.test(line) ? "label" : ""}">${escape(line) || "&nbsp;"}</div>`,
      )
      .join("");
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
    });
    await page.setContent(`<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(title)}</title><style>
      *{box-sizing:border-box}body{margin:0;background:#111315;color:#f3f0e8;font-family:Arial,Helvetica,sans-serif}main{position:relative;width:1280px;padding:44px 48px 36px}.brand-mark{position:absolute;top:34px;right:48px;width:72px;height:72px;object-fit:contain}.eyebrow{font:13px ui-monospace,Menlo,monospace;letter-spacing:1.8px;color:#ff895f;margin:0 0 18px}h1{font-size:40px;letter-spacing:-1px;line-height:1.15;margin:0 0 12px}p{font-size:18px;line-height:1.5;color:#b9c0c4;margin:0 0 28px}.terminal{border:1px solid #40464a;background:#181c20;border-radius:10px;overflow:hidden}.bar{height:44px;padding:14px 20px;border-bottom:1px solid #373e43;font:13px ui-monospace,Menlo,monospace;color:#b9c0c4;display:flex;justify-content:space-between}.dot{color:#ff6b35}.content{padding:22px 24px;font:16px/1.58 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.line.owner{color:#ffad8d}.line.state{color:#a6d6b0}.line.label{color:#a7b0b6}.foot{margin:22px 0 0;font:12px/1.5 ui-monospace,Menlo,monospace;color:#9ca6ad;display:flex;justify-content:space-between}
      </style><main><img class="brand-mark" src="${logo}" alt=""><div class="eyebrow">PLOMPY-ENGINE / OFFLINE DEMONSTRATION</div><h1>${escape(title)}</h1><p>${escape(subtitle)}</p><section class="terminal"><div class="bar"><span><span class="dot">●</span> node scripts/demo.mjs ${mode}</span><span>Node 26 · SQLite</span></div><div class="content">${lines}</div></section><div class="foot"><span>REAL ENGINE + STORE · SYNTHETIC TRANSPORT · NO MODEL CALLS</span><span>plompy-engine / MIT</span></div></main></html>`);
    await page.evaluate(() => document.fonts.ready);
    await page
      .locator("main")
      .screenshot({ path: join(output, `${mode}.png`) });
    await page.close();
    console.log(`Captured ${mode}: real offline demo output, synthetic data.`);
  }
} finally {
  await browser.close();
}
