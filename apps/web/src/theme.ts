export type ThemeChoice = "light" | "dark" | "system";

const STORAGE_KEY = "coflow.theme.v1";

function media() {
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
}

export function readTheme(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system")
      return value;
  } catch {
    // Storage can be unavailable or blocked; the system default is fine.
  }
  return "system";
}

export function resolveTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice !== "system") return choice;
  return media()?.matches ? "dark" : "light";
}

/**
 * Stamp the resolved theme on the root element.
 *
 * `data-theme` is always written, including for "light", so the dark tokens are
 * never picked up by a stale attribute; the stylesheet keys entirely off this
 * one attribute rather than also reading the media query, which keeps a manual
 * choice authoritative.
 */
export function applyTheme(choice: ThemeChoice) {
  const resolved = resolveTheme(choice);
  document.documentElement.dataset.theme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolved === "dark" ? "#12161f" : "#f7f7f4");
}

export function writeTheme(choice: ThemeChoice) {
  try {
    window.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Not persisting is a smaller failure than not switching.
  }
  applyTheme(choice);
}

/** Re-resolve while the choice is "system" and the OS setting changes. */
export function watchSystemTheme(onChange: () => void) {
  const query = media();
  if (!query) return () => {};
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
