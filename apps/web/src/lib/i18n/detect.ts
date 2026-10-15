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
 * Cookie, otherwise English. A first visit does not follow navigator.language:
 * the product default is English until the operator picks a language.
 */
export function detectClientLocale(): Locale {
  return cookieLocale() ?? DEFAULT_LOCALE
}
