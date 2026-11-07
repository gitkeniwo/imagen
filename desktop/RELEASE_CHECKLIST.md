# Release checklist

## 1. Before tagging: run the checks on `main`

Either run the workflow on `main` and wait for green:

```bash
gh workflow run ui-check.yml --ref main
gh run watch "$(gh run list --workflow ui-check.yml --branch main --limit 1 --json databaseId -q '.[0].databaseId')"
```

or run the same thing locally (macOS; ~5 minutes):

```bash
desktop/scripts/release_check.sh
```

It runs `check_frontend`, `check_roles`, `check_providers`,
`check_generate_stream`, `smoke_backend` and `check_ui` (Playwright in
Chromium, WebKit and a 375×812 touch viewport) and ends with
`RELEASE CHECK PASS` or `RELEASE CHECK FAIL`. Nothing calls Vertex or the
Gemini API; every check uses throwaway libraries and ports 47901–47999.

Only tag once it is green. Pushing the `v<version>` tag runs
`desktop-release.yml`, which runs the same `ui-check` job first: if it fails,
nothing is built or published and the Homebrew tap is not touched.

## 2. If the checks fail inside the release workflow

The tag exists but no release was made. Delete the tag on the remote and
locally, fix on `main`, then tag again (example for `v0.2.22`):

```bash
git push origin :refs/tags/v0.2.22
git tag -d v0.2.22
# fix on main (PR, merge), then:
git switch main && git pull --ff-only
gh workflow run ui-check.yml --ref main   # wait for green
git tag -a --cleanup=verbatim -F notes.md v0.2.22
git push origin v0.2.22
```

The Playwright report, traces, screenshots and videos are attached to the
failed run as the `playwright-report-*` artifact (backend logs as
`backend-logs-*`). Open a trace with `npx playwright show-trace trace.zip`
in `e2e/`.

## 3. Manual pass on the built app (≤ 2 minutes)

CI drives the web UI in a browser; it cannot drive the Tauri shell. On the
DMG build (or `desktop/build.sh` app), with a test library:

- [ ] Right-click an image (library tile, viewer): **no system image menu**
      (Copy Image / Download Image), only Imagen's menu.
- [ ] Context menu › **Download** saves the file (check `~/Downloads`).
- [ ] Menu bar icon: the **popover** opens under the icon and shows status.
- [ ] **⌘W** hides the window and the app keeps running in the background
      (no Dock icon); reopening from the menu bar brings it back.
- [ ] With a generation running, **hold ⌘Q**: the HUD appears and the app
      quits only after holding; a short press does not quit.
