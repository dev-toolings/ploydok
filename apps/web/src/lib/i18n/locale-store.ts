// SPDX-License-Identifier: AGPL-3.0-only

import { DEFAULT_LOCALE, LOCALE_COOKIE } from "./locales"
import i18n from "./index"
import type { Locale } from "./locales"

function persist(locale: Locale): void {
  if (typeof document === "undefined") return
  const secure = location.protocol === "https:" ? "; Secure" : ""
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
  document.documentElement.setAttribute("lang", locale)
}

/** Persist the locale cookie, set `<html lang>`, and re-render through i18next. */
export function changeLocale(locale: Locale): void {
  persist(locale)
  void i18n.changeLanguage(locale)
}

/**
 * A first visit has no `ploydok-locale` cookie. Select English so the
 * switcher and the next request both treat EN as the chosen language.
 */
export function ensureDefaultLocaleSelected(): void {
  if (typeof document === "undefined") return
  const chosen = document.cookie
    .split(";")
    .some((part) => part.trim().startsWith(`${LOCALE_COOKIE}=`))
  if (chosen) return
  changeLocale(DEFAULT_LOCALE)
}
