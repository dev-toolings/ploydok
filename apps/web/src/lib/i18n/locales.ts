// SPDX-License-Identifier: AGPL-3.0-only

export const LOCALES = ["en", "fr"] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = "en"
export const LOCALE_COOKIE = "ploydok-locale"

export function isLocale(value: string): value is Locale {
  return value === "en" || value === "fr"
}

/** Map a BCP 47 tag (`fr-FR`, `en`) to a supported locale, or null. */
export function resolveSupportedLocale(
  value: string | null | undefined
): Locale | null {
  if (!value) return null
  const base = value.trim().toLowerCase().split(/[-_]/)[0]
  return isLocale(base) ? base : null
}
