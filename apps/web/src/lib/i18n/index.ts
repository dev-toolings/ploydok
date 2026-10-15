// SPDX-License-Identifier: AGPL-3.0-only

import i18n from "i18next"
import { initReactI18next } from "react-i18next"

import { detectClientLocale } from "./detect"
import { loadResources } from "./load-resources"
import { DEFAULT_LOCALE, LOCALES } from "./locales"

/**
 * App-wide i18next instance. Every namespace is one `locales/<lng>/<ns>.json`,
 * so the file tree is the registry — globbed (Vite) or read from disk (bun tests)
 * rather than listed by hand.
 */

const resources = loadResources()
const namespaces = Object.keys(resources.en ?? {}).sort()

let initialized = false

export function setupI18n(): typeof i18n {
  if (!initialized) {
    i18n.use(initReactI18next).init({
      resources,
      lng: detectClientLocale(),
      fallbackLng: DEFAULT_LOCALE,
      supportedLngs: [...LOCALES],
      load: "languageOnly",
      defaultNS: "common",
      ns: namespaces,
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    })
    initialized = true
  }
  return i18n
}

setupI18n()

export default i18n
