import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO, RUN_DIR, RUN_MARKER, TEMPLATE_DIR, pythonCommand } from "./paths";

// Builds the deterministic template library once per run. Every test file
// then gets its own copy of it (see fixtures.ts), so files never share state.
export default async function globalSetup() {
  if (process.platform !== "darwin") {
    throw new Error("The UI checks need macOS: desktop/scripts/fake_backend.py is macOS-only.");
  }
  const index = path.join(REPO, "frontend", "dist", "index.html");
  if (!fs.existsSync(index)) {
    throw new Error("frontend/dist is missing. Run `npm run build` in frontend/ (check_ui.sh does this).");
  }

  if (fs.existsSync(RUN_DIR)) {
    // Throwaway libraries from an earlier run. Only a directory this setup
    // created (it carries the marker) is discarded, and only to the Trash.
    if (!fs.existsSync(path.join(RUN_DIR, RUN_MARKER))) {
      throw new Error(`${RUN_DIR} exists but was not created by the UI checks; refusing to touch it.`);
    }
    execFileSync("/usr/bin/trash", [RUN_DIR]);
  }
  fs.mkdirSync(path.join(RUN_DIR, "logs"), { recursive: true });
  fs.writeFileSync(path.join(RUN_DIR, RUN_MARKER), "Throwaway Playwright libraries; safe to delete.\n");

  const [cmd, ...pre] = pythonCommand();
  // Workers spawn the interpreter directly (no `uv run` wrapper to signal).
  process.env.IMAGEN_E2E_PYTHON_RESOLVED = execFileSync(
    cmd,
    [...pre, "-c", "import sys; print(sys.executable)"],
    { cwd: REPO, encoding: "utf8" },
  ).trim();
  const started = Date.now();
  execFileSync(
    cmd,
    [
      ...pre,
      path.join(REPO, "desktop", "scripts", "e2e_build_library.py"),
      "--data-dir",
      TEMPLATE_DIR,
      "--port",
      process.env.IMAGEN_E2E_BUILD_PORT || "47919",
      "--log",
      path.join(RUN_DIR, "logs", "template-build.log"),
    ],
    { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] },
  );
  console.log(`[e2e] template library built in ${((Date.now() - started) / 1000).toFixed(1)}s: ${TEMPLATE_DIR}`);
}
