// SPDX-License-Identifier: AGPL-3.0-only
import i18n from "./i18n"
import { DEFAULT_LOCALE } from "./i18n/locales"
import type catalog from "../locales/en/metadata.json"

type Page = keyof typeof catalog
type MetadataMatch = {
  context: { locale?: string }
  loaderData?: unknown
}

export function formatPageTitle(page?: string, brand = "Ploydok"): string {
  const title = page && page !== brand ? `${page} | ${brand}` : brand
  return import.meta.env.DEV ? `${title} (DEV)` : title
}

function resourceName(matches: Array<MetadataMatch>): string | undefined {
  for (const match of [...matches].reverse()) {
    const data = match.loaderData
    if (!data || typeof data !== "object") continue
    for (const key of ["app", "organization"] as const) {
      if (!(key in data)) continue
      const resource = (data as Record<string, unknown>)[key]
      if (
        resource &&
        typeof resource === "object" &&
        "name" in resource &&
        typeof resource.name === "string"
      ) return resource.name
    }
  }
}

/** Route heads share formatting, but translate with the SSR request's locale. */
export function createPageHead(page: Page) {
  return ({ matches }: { matches: Array<MetadataMatch> }) => {
    const t = i18n.getFixedT(
      matches[0]?.context.locale ?? DEFAULT_LOCALE,
      "metadata"
    )
    const label = t(`${page}.title`)
    const resource = resourceName(matches)
    return {
      meta: [
        { title: formatPageTitle(resource ? `${label} | ${resource}` : label) },
        { name: "description", content: t(`${page}.description`) },
      ],
    }
  }
}
