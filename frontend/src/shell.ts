// Navigate through the Tauri shell's fixed action scheme. The page only names
// an action; the shell owns and validates every path.
export function shellAction(action: string) {
  window.location.href = `imagen-action://${action}`;
}
