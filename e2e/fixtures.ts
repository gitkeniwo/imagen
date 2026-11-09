import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { LOG_DIR, REPO, RUN_DIR, TEMPLATE_DIR } from "./paths";

const BASE_PORT = Number(process.env.IMAGEN_E2E_BASE_PORT || 47920);

interface Backend {
  proc: ChildProcess;
  url: string;
  dir: string;
  log: string;
  key: string;
}

interface Server {
  current: Backend | null;
  count: number;
}

async function stop(b: Backend | null) {
  if (!b || b.proc.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => b.proc.once("exit", () => resolve()));
  b.proc.kill("SIGTERM");
  const timer = setTimeout(() => b.proc.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(timer);
}

async function start(workerIndex: number, parallelIndex: number, n: number, key: string): Promise<Backend> {
  const port = BASE_PORT + parallelIndex;
  if (port < 47901 || port > 47999) throw new Error(`port ${port} is outside 47901-47999`);
  const name = `w${workerIndex}-${n}`;
  const dir = path.join(RUN_DIR, "libs", name);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(TEMPLATE_DIR, dir, { recursive: true });
  const log = path.join(LOG_DIR, `${name}.log`);
  const out = fs.openSync(log, "w");
  fs.writeSync(out, `# ${key}\n`);
  const token = randomBytes(8).toString("hex");
  const python = process.env.IMAGEN_E2E_PYTHON_RESOLVED!;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    IMAGEN_DATA_DIR: dir,
    IMAGEN_LIBRARY_MODE: "existing",
    IMAGEN_PORT: String(port),
    IMAGEN_INSTANCE_TOKEN: token,
    IMAGEN_LOG_DIR: path.join(LOG_DIR, `${name}-app`),
    FAKE_DELAY_S: process.env.FAKE_DELAY_S ?? "1",
    FAKE_SLOW_S: process.env.FAKE_SLOW_S ?? "60",
  };
  delete env.IMAGEN_GEMINI_API_KEY;
  delete env.IMAGEN_PARENT_WATCH;
  const proc = spawn(python, [path.join(REPO, "desktop", "scripts", "e2e_fake_backend.py")], {
    env,
    cwd: REPO,
    stdio: ["ignore", out, out],
  });
  fs.closeSync(out);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`fake backend exited with ${proc.exitCode}; see ${log}`);
    }
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok && (await res.json()).token === token) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      await stop({ proc, url, dir, log, key });
      throw new Error(`fake backend on ${port} not healthy within 30s; see ${log}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { proc, url, dir, log, key };
}

type WorkerFixtures = { server: Server };
type TestFixtures = {
  /** Restart on a fresh library copy for every test (default: per file). */
  freshLibrary: boolean;
  library: Backend;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  server: [
    async ({}, use) => {
      const server: Server = { current: null, count: 0 };
      await use(server);
      await stop(server.current);
    },
    { scope: "worker" },
  ],
  freshLibrary: [false, { option: true }],
  // One library per test file (or per test with freshLibrary), never shared
  // across files, so tests that change data cannot affect each other.
  library: async ({ server, freshLibrary }, use, testInfo) => {
    const key = freshLibrary ? `${testInfo.file}#${testInfo.testId}` : testInfo.file;
    if (!server.current || server.current.key !== key || server.current.proc.exitCode !== null) {
      await stop(server.current);
      server.current = null;
      server.current = await start(testInfo.workerIndex, testInfo.parallelIndex, ++server.count, key);
    }
    await use(server.current);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("backend.log", { path: server.current.log, contentType: "text/plain" });
    }
  },
  baseURL: async ({ library }, use) => {
    await use(library.url);
  },
});

export { expect };

// ---------------------------------------------------------------- helpers

/** The open context menu panel (not the submenu). */
export const contextMenu = (page: Page) => page.locator(".context-menu-panel");
export const submenu = (page: Page) => page.locator(".context-menu-submenu");

export async function openApp(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Library" })).toBeVisible();
  await expect(libraryTiles(page).first()).toBeVisible();
}

/** Library thumbnails in the sidebar (the main button of each tile). */
export const libraryTiles = (page: Page) => page.locator(".library-grid .lib-tile > img");

export async function rightClick(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  await target.click({ button: "right" });
}

/** Accessible names of the open panel's items (quick actions first), in order. */
export async function menuLabels(page: Page): Promise<string[]> {
  const panel = contextMenu(page);
  await expect(panel).toBeVisible();
  return panel.getByRole("menuitem").evaluateAll((els) =>
    els.map(
      (el) =>
        el.getAttribute("aria-label") ||
        (el.querySelector(".context-menu-label, span:not(.context-check)")?.textContent ?? el.textContent ?? "").trim(),
    ),
  );
}

export async function menuTitle(page: Page): Promise<string> {
  return (await contextMenu(page).locator(".context-preview-text strong").innerText()).trim();
}

export async function sidebarTab(page: Page, name: "Library" | "History" | "Favorites" | "Drafts") {
  await page.getByRole("tab", { name }).click();
  await expect(page.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
}

/** Records `defaultPrevented` of the next contextmenu event after all listeners ran. */
export async function watchContextMenuDefault(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __ctx: unknown[] }).__ctx = [];
    window.addEventListener("contextmenu", (e) => {
      (window as unknown as { __ctx: unknown[] }).__ctx.push(e.defaultPrevented);
    });
  });
  return async () => page.evaluate(() => (window as unknown as { __ctx: boolean[] }).__ctx);
}
