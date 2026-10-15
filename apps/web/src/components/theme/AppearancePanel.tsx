// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { RiComputerLine, RiMoonLine, RiSunLine } from "@remixicon/react"
import { useTranslation } from "react-i18next"
import { cn } from "@workspace/ui/lib/utils"
import { LanguageSwitcher } from "../i18n/LanguageSwitcher"
import { useTheme } from "./ThemeToggle"
import type { ThemeMode } from "./ThemeToggle"

const THEME_OPTIONS: ReadonlyArray<{
  value: ThemeMode
  labelKey: "theme.light" | "theme.dark" | "theme.system"
  hintKey: "theme.lightHint" | "theme.darkHint" | "theme.systemHint"
  icon: React.ComponentType<{ className?: string }>
}> = [
  {
    value: "light",
    labelKey: "theme.light",
    hintKey: "theme.lightHint",
    icon: RiSunLine,
  },
  {
    value: "dark",
    labelKey: "theme.dark",
    hintKey: "theme.darkHint",
    icon: RiMoonLine,
  },
  {
    value: "system",
    labelKey: "theme.system",
    hintKey: "theme.systemHint",
    icon: RiComputerLine,
  },
]

export function AppearancePanel(): React.JSX.Element {
  const { t } = useTranslation("common")
  const { mode, resolved, setMode } = useTheme()
  return (
    <section
      aria-label={t("theme.label")}
      className="space-y-6 rounded-2xl bg-panel p-5"
    >
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">{t("theme.label")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("theme.description")}
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label={t("theme.group")}
          className="grid gap-2 sm:grid-cols-3"
        >
          {THEME_OPTIONS.map((opt) => {
            const Icon = opt.icon
            const active = mode === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={(event) => setMode(opt.value, event.currentTarget)}
                className={cn(
                  "flex w-full flex-col items-start gap-1.5 rounded-[10px] bg-panel-inset p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring shadow-[0_1px_1px_0_#0000000d] dark:shadow-[0_1px_1px_0_#00000024]",
                  active
                    ? "border-primary ring-1 ring-primary"
                    : "hover:border-muted-foreground/30 hover:bg-accent/40"
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <Icon className="size-4" />
                  {t(opt.labelKey)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t(opt.hintKey)}
                </span>
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("theme.current", { mode: resolved })}
        </p>
      </div>
      <div className="space-y-2 border-t border-border pt-4">
        <div>
          <h3 className="text-sm font-medium">{t("language.label")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("language.description")}
          </p>
        </div>
        <LanguageSwitcher />
      </div>
    </section>
  )
}
