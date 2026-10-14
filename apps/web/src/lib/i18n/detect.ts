// SPDX-License-Identifier: AGPL-3.0-only

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  resolveSupportedLocale,
} from "./locales"
import type { Locale } from "./locales"

function cookieLocale(): Locale | null {
  if (typeof document === "undefined") return null
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]+)`)
  )
  return match
    ? resolveSupportedLocale(decodeURIComponent(match[1]))
    : null
}

/**
 * Cookie → navigator.language → default. On the server this is the default
 * until `resolveRequestLocale` swaps the shared instance in root `beforeLoad`.
 */
export function detectClientLocale(): Locale {
  const fromCookie = cookieLocale()
  if (fromCookie) return fromCookie
  if (typeof navigator !== "undefined" && navigator.language) {
    return resolveSupportedLocale(navigator.language) ?? DEFAULT_LOCALE
  }
  return DEFAULT_LOCALE
}
