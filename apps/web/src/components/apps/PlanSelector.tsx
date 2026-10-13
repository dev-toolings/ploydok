// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { RiCpuLine, RiDatabase2Line, RiGitBranchLine } from "@remixicon/react"
import { PLANS, PLAN_NAMES  } from "@ploydok/shared"
import { Input } from "@workspace/ui/components/input"
import { cn } from "@workspace/ui/lib/utils"
import { useTranslation } from "react-i18next"
import type { PlanName } from "@ploydok/shared"

export interface PlanSelectorValue {
  plan: PlanName
  cpuLimit?: number
  memLimitMB?: number
  pidsLimit?: number
}

interface PlanSelectorProps {
  value: PlanSelectorValue
  onChange: (value: PlanSelectorValue) => void
}

export function PlanSelector({ value, onChange }: PlanSelectorProps): React.JSX.Element {
  const { t } = useTranslation("apps")
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label={t("plan.aria")} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {PLAN_NAMES.map((name) => (
          <PlanOption
            key={name}
            name={name}
            active={value.plan === name}
            onSelect={() => onChange({ ...value, plan: name })}
          />
        ))}
      </div>
      {value.plan === "custom" ? (
        <CustomLimits value={value} onChange={onChange} />
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Plan radio card
// ---------------------------------------------------------------------------

function PlanOption({
  name,
  active,
  onSelect,
}: {
  name: PlanName
  active: boolean
  onSelect: () => void
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  const limits = PLANS[name]
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors",
        active
          ? "border-primary/50 bg-primary/5"
          : "border-border bg-card hover:border-primary/30",
      )}
    >
      <div className="flex w-full items-center justify-between">
        <span className="text-sm font-medium">{t(`plan.${name}`)}</span>
        {active ? (
          <span className="size-2 rounded-full bg-primary" />
        ) : (
          <span className="size-2 rounded-full border border-border" />
        )}
      </div>
      <span className="font-sans text-[10px] tracking-wide text-muted-foreground uppercase">
        {t(`plan.${name}Hint`)}
      </span>
      {limits ? (
        <dl className="grid w-full grid-cols-3 gap-1 text-[11px]">
          <PlanStat icon={RiCpuLine} label={`${limits.cpu} CPU`} />
          <PlanStat icon={RiDatabase2Line} label={`${limits.memMB} MB`} />
          <PlanStat icon={RiGitBranchLine} label={`${limits.pids} pids`} />
        </dl>
      ) : (
        <span className="text-[11px] text-muted-foreground">{t("plan.defineBelow")}</span>
      )}
    </button>
  )
}

function PlanStat({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 truncate font-sans text-[10px] text-muted-foreground">
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Custom inputs
// ---------------------------------------------------------------------------

function CustomLimits({
  value,
  onChange,
}: {
  value: PlanSelectorValue
  onChange: (value: PlanSelectorValue) => void
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">{t("plan.leaveEmpty")}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <NumberField
          id="custom-cpu"
          label={t("plan.cpuCores")}
          placeholder="0.5"
          step="0.1"
          min={0}
          value={value.cpuLimit}
          onChange={(n) => onChange({ ...value, cpuLimit: n })}
        />
        <NumberField
          id="custom-mem"
          label={t("plan.memoryMb")}
          placeholder="512"
          step="1"
          min={0}
          value={value.memLimitMB}
          onChange={(n) => onChange({ ...value, memLimitMB: n })}
        />
        <NumberField
          id="custom-pids"
          label={t("plan.pids")}
          placeholder="256"
          step="1"
          min={0}
          value={value.pidsLimit}
          onChange={(n) => onChange({ ...value, pidsLimit: n })}
        />
      </div>
    </div>
  )
}

interface NumberFieldProps {
  id: string
  label: string
  placeholder: string
  step: string
  min: number
  value: number | undefined
  onChange: (n: number | undefined) => void
}

function NumberField({
  id,
  label,
  placeholder,
  step,
  min,
  value,
  onChange,
}: NumberFieldProps): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium">
        {label}
      </label>
      <Input
        id={id}
        type="number"
        step={step}
        min={min}
        placeholder={placeholder}
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value
          if (raw.trim() === "") {
            onChange(undefined)
            return
          }
          const parsed = Number(raw)
          if (Number.isFinite(parsed)) onChange(parsed)
        }}
        className="h-9 text-sm"
      />
    </div>
  )
}
