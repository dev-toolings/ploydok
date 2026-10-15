// SPDX-License-Identifier: AGPL-3.0-only

import { createIsomorphicFn } from "@tanstack/react-start"
import { detectClientLocale } from "./detect"
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  resolveSupportedLocale,
} from "./locales"
import type { Locale } from "./locales"

/**
 * Request locale that SSR HTML and client hydration both boot with.
 * Cookie first on both sides, so an explicit choice never mismatches.
 * With no cookie the instance stays English, including on a French browser.
 */
export const resolveRequestLocale = createIsomorphicFn()
  .server(async (): Promise<Locale> => {
    try {
      const { getCookies } = await import("@tanstack/react-start/server")
      const cookies = getCookies()
      return resolveSupportedLocale(cookies[LOCALE_COOKIE]) ?? DEFAULT_LOCALE
    } catch {
      return DEFAULT_LOCALE
    }
  })
  .client((): Locale => detectClientLocale())
