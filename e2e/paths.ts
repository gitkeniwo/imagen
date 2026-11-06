import path from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(E2E_DIR, "..");

// Throwaway libraries, backend logs and the template live here. Never the
// real backend/data or ~/.config/imagen.
export const RUN_DIR = path.resolve(process.env.IMAGEN_E2E_RUN_DIR || path.join(E2E_DIR, ".run"));
export const TEMPLATE_DIR = path.join(RUN_DIR, "template");
export const LOG_DIR = path.join(RUN_DIR, "logs");
export const RUN_MARKER = ".imagen-e2e-run";

/** Python that can import the backend (`uv run` by default). */
export function pythonCommand(): string[] {
  const custom = process.env.IMAGEN_E2E_PYTHON;
  if (custom) return [custom];
  return ["uv", "run", "--project", path.join(REPO, "backend"), "python"];
}
