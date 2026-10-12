import type { RenderSurface } from 'claude-code'

/** The system's own clipboard tools, tried in order: macOS, Windows, Wayland, X11. */
export const SYSTEM_CLIPBOARD_TOOLS: readonly (readonly string[])[] = [
  ['pbcopy'],
  ['powershell', '-NoProfile', '-Command', 'Set-Clipboard -Value ([Console]::In.ReadToEnd())'],
  ['wl-copy'],
  ['xclip', '-selection', 'clipboard'],
]

/**
 * Whether a surface runs on the machine the session runs on, where the
 * system clipboard is the person's own. A remote surface (the mobile app)
 * writes its own clipboard or none.
 */
export function isLocalSurface(surface: RenderSurface | undefined): boolean {
  return surface === undefined || surface === 'terminal' || surface === 'desktop'
}
