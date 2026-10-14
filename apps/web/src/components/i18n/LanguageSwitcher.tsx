// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@workspace/ui/lib/utils"
import { changeLocale } from "../../lib/i18n/locale-store"
import { LOCALES } from "../../lib/i18n/locales"

export function LanguageSwitcher({
  className,
  compact = false,
}: {
  className?: string
  compact?: boolean
}): React.JSX.Element {
  const { t, i18n } = useTranslation("common")
  const active =
    LOCALES.find((locale) => i18n.language.startsWith(locale)) ?? "en"

  return (
    <fieldset className={cn("flex items-center gap-1", className)}>
      <legend className="sr-only">{t("language.label")}</legend>
      {LOCALES.map((locale) => {
        const selected = active === locale
        return (
          <button
            key={locale}
            type="button"
            onClick={() => changeLocale(locale)}
            aria-pressed={selected}
            className={cn(
              "rounded-md px-2 py-1 font-sans text-[11px] font-medium uppercase transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {compact ? locale : t(`language.${locale}`)}
          </button>
        )
      })}
    </fieldset>
  )
}
