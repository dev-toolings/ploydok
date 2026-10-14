// SPDX-License-Identifier: AGPL-3.0-only

import { createIsomorphicFn } from "@tanstack/react-start"
import { detectClientLocale } from "./detect"
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  parseAcceptLanguage,
  resolveSupportedLocale,
} from "./locales"
import type { Locale } from "./locales"

/**
 * Request locale that SSR HTML and client hydration both boot with.
 * Cookie first on both sides, so an explicit choice never mismatches.
 */
export const resolveRequestLocale = createIsomorphicFn()
  .server(async (): Promise<Locale> => {
    try {
      const { getCookies, getRequestHeader } = await import(
        "@tanstack/react-start/server"
      )
      const cookies = getCookies()
      const fromCookie = resolveSupportedLocale(cookies[LOCALE_COOKIE])
      if (fromCookie) return fromCookie
      return parseAcceptLanguage(getRequestHeader("accept-language"))
    } catch {
      return DEFAULT_LOCALE
    }
  })
  .client((): Locale => detectClientLocale())
