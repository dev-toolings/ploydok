// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { flushSync } from "react-dom"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"

export type ThemeMode = "light" | "dark" | "system"
export type ResolvedTheme = "light" | "dark"

export const THEME_COOKIE = "ploydok-theme"
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 // 1 year

function readCookie(): ThemeMode {
  if (typeof document === "undefined") return "light"
  const match = document.cookie.match(
    new RegExp("(?:^|; )" + THEME_COOKIE + "=([^;]+)")
  )
  const value = match ? decodeURIComponent(match[1]) : null
  if (value === "light" || value === "dark" || value === "system") return value
  return "light"
}

function writeCookie(mode: ThemeMode): void {
  if (typeof document === "undefined") return
  document.cookie =
    THEME_COOKIE +
    "=" +
    encodeURIComponent(mode) +
    "; path=/; max-age=" +
    COOKIE_MAX_AGE +
    "; samesite=lax"
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") return systemPrefersDark() ? "dark" : "light"
  return mode
}

function applyResolved(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return
  document.documentElement.classList.toggle("dark", resolved === "dark")
  document.documentElement.style.colorScheme = resolved
}

const THEME_TRANSITION_STYLE_ID = "ploydok-theme-transition-style"
const THEME_TRANSITION_MS = 820
const THEME_TRANSITION_MASK = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2" /></filter></defs><circle cx="50" cy="50" r="42" fill="white" filter="url(#blur)" /></svg>'
)}")`
let themeTransitionRunning = false

function currentResolved(): ResolvedTheme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light"
}

function transitionOrigin(origin?: Element | null): { x: number; y: number } {
  const rect = origin?.getBoundingClientRect()
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2
  const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2
  return {
    x: Math.min(Math.max(x, 0), window.innerWidth),
    y: Math.min(Math.max(y, 0), window.innerHeight),
  }
}

function injectRevealStyle(x: number, y: number): HTMLStyleElement {
  document.getElementById(THEME_TRANSITION_STYLE_ID)?.remove()
  const radius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y)
  )
  // The blurred circle fills 84% of its viewBox, so the mask must outgrow
  // the farthest corner distance to fully uncover the viewport.
  const size = radius * 2.5
  const style = document.createElement("style")
  style.id = THEME_TRANSITION_STYLE_ID
  style.textContent = `
    ::view-transition-new(root) {
      -webkit-mask-image: ${THEME_TRANSITION_MASK};
      mask-image: ${THEME_TRANSITION_MASK};
      -webkit-mask-repeat: no-repeat;
      mask-repeat: no-repeat;
      animation: ploydok-theme-reveal ${THEME_TRANSITION_MS}ms cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    @keyframes ploydok-theme-reveal {
      from {
        -webkit-mask-position: ${x}px ${y}px;
        mask-position: ${x}px ${y}px;
        -webkit-mask-size: 0px 0px;
        mask-size: 0px 0px;
      }
      to {
        -webkit-mask-position: ${x - size / 2}px ${y - size / 2}px;
        mask-position: ${x - size / 2}px ${y - size / 2}px;
        -webkit-mask-size: ${size}px ${size}px;
        mask-size: ${size}px ${size}px;
      }
    }
  `
  document.head.appendChild(style)
  return style
}

/**
 * Reveals the next theme through a circle growing from `origin`. Falls back to
 * an instant swap without View Transitions, under reduced motion, or when the
 * resolved theme does not change (light to system on a light OS).
 */
function runThemeTransition(
  next: ResolvedTheme,
  update: () => void,
  origin?: Element | null
): void {
  const commit = (): void => {
    flushSync(update)
    applyResolved(next)
  }
  if (
    typeof document === "undefined" ||
    typeof document.startViewTransition !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    currentResolved() === next ||
    themeTransitionRunning
  ) {
    commit()
    return
  }

  const { x, y } = transitionOrigin(origin)
  themeTransitionRunning = true
  document.documentElement.classList.add("theme-transitioning")
  const style = injectRevealStyle(x, y)
  const cleanup = (): void => {
    style.remove()
    document.documentElement.classList.remove("theme-transitioning")
    themeTransitionRunning = false
  }
  try {
    document.startViewTransition(commit).finished.finally(cleanup)
  } catch {
    cleanup()
    commit()
  }
}

export function useTheme(): {
  mode: ThemeMode
  resolved: ResolvedTheme
  setMode: (mode: ThemeMode, origin?: Element | null) => void
  toggle: (origin?: Element | null) => void
} {
  const [mode, setModeState] = React.useState<ThemeMode>(readCookie)
  // The server renders without the cookie, so the first client render must
  // match its light markup; the real theme shows once hydration is done.
  const [hydrated, setHydrated] = React.useState(false)
  React.useEffect(() => setHydrated(true), [])
  const [resolved, setResolved] = React.useState<ResolvedTheme>(() =>
    resolve(readCookie())
  )

  React.useEffect(() => {
    const next = resolve(mode)
    setResolved(next)
    applyResolved(next)
    writeCookie(mode)
  }, [mode])

  // Follow OS pref changes when in system mode
  React.useEffect(() => {
    if (mode !== "system" || typeof window === "undefined") return
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const handler = (e: MediaQueryListEvent): void => {
      const next: ResolvedTheme = e.matches ? "dark" : "light"
      setResolved(next)
      applyResolved(next)
    }
    mq.addEventListener("change", handler)
    return () => mq.removeEventListener("change", handler)
  }, [mode])

  // Sync across tabs via cookie polling on focus
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const onFocus = (): void => {
      const fromCookie = readCookie()
      if (fromCookie !== mode) setModeState(fromCookie)
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [mode])

  const setMode = React.useCallback(
    (next: ThemeMode, origin?: Element | null) => {
      runThemeTransition(resolve(next), () => setModeState(next), origin)
    },
    []
  )

  const toggle = React.useCallback((origin?: Element | null) => {
    const next: ResolvedTheme = currentResolved() === "dark" ? "light" : "dark"
    runThemeTransition(next, () => setModeState(next), origin)
  }, [])

  return {
    mode: hydrated ? mode : "light",
    resolved: hydrated ? resolved : "light",
    setMode,
    toggle,
  }
}

export function ThemeToggle(): React.JSX.Element {
  const { resolved, toggle } = useTheme()
  const { t } = useTranslation("common")

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={(event) => toggle(event.currentTarget)}
      aria-label={
        resolved === "dark" ? t("theme.switchToLight") : t("theme.switchToDark")
      }
    >
      {resolved === "dark" ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      )}
    </Button>
  )
}
