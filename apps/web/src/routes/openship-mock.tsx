// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import {
  RiAddLine,
  RiArrowUpSLine,
  RiCloudLine,
  RiComputerLine,
  RiDashboardLine,
  RiEqualizer2Line,
  RiFolder3Line,
  RiGitBranchLine,
  RiGithubLine,
  RiGlobalLine,
  RiHammerLine,
  RiLogoutBoxRLine,
  RiMoonLine,
  RiPlayLine,
  RiPulseLine,
  RiRocketLine,
  RiServerLine,
  RiSettings3Line,
  RiShieldCheckLine,
  RiSidebarFoldLine,
} from "@remixicon/react"
import { useTranslation } from "react-i18next"
import { createPageHead } from "../lib/page-metadata"

export const Route = createFileRoute("/openship-mock")({
  head: createPageHead("mock"),
  component: OpenShipMockPage,
})

type StackCategory = "frontend" | "backend" | "fullstack" | "static"

type Framework = {
  name: string
  mark: string
  color: string
  category: StackCategory
}

const STACK_CATEGORIES: Array<StackCategory> = [
  "frontend",
  "backend",
  "fullstack",
  "static",
]

// Fullstack tiles match docs/screenshots/screen.png (Blazor on this tab,
// TanStack Start omitted). Other tabs filter for real, not cosmetic.
const frameworks: Array<Framework> = [
  { name: "Next.js", mark: "N", color: "bg-black text-white", category: "fullstack" },
  { name: "Nuxt", mark: "△", color: "text-emerald-500", category: "fullstack" },
  { name: "SvelteKit", mark: "S", color: "text-orange-600", category: "fullstack" },
  { name: "Remix", mark: "⚛", color: "text-sky-400", category: "fullstack" },
  { name: "AdonisJS", mark: "A", color: "bg-indigo-600 text-white", category: "fullstack" },
  { name: "Django", mark: "dj", color: "text-emerald-950", category: "fullstack" },
  { name: "Ruby on Rails", mark: "R", color: "text-red-600", category: "fullstack" },
  { name: "Laravel", mark: "◇", color: "text-red-400", category: "fullstack" },
  { name: "Symfony", mark: "sf", color: "bg-black text-white", category: "fullstack" },
  { name: "Blazor", mark: ".NET", color: "bg-violet-700 text-white", category: "fullstack" },
  { name: "Phoenix", mark: "≋", color: "text-orange-600", category: "fullstack" },
  { name: "Vite", mark: "V", color: "text-violet-600", category: "frontend" },
  { name: "Angular", mark: "A", color: "text-red-600", category: "frontend" },
  { name: "Astro", mark: "Ast", color: "bg-orange-600 text-white", category: "frontend" },
  { name: "Vue CLI", mark: "V", color: "text-emerald-600", category: "frontend" },
  { name: "Gatsby", mark: "G", color: "text-purple-700", category: "frontend" },
  { name: "React", mark: "⚛", color: "text-sky-500", category: "frontend" },
  { name: "Express", mark: "ex", color: "bg-black text-white", category: "backend" },
  { name: "NestJS", mark: "N", color: "text-red-600", category: "backend" },
  { name: "FastAPI", mark: "⚡", color: "text-teal-600", category: "backend" },
  { name: "Go", mark: "Go", color: "text-sky-600", category: "backend" },
  { name: "Spring Boot", mark: "🍃", color: "text-green-700", category: "backend" },
  { name: ".NET", mark: ".NET", color: "bg-violet-700 text-white", category: "backend" },
  { name: "Static Site", mark: "{}", color: "text-neutral-700", category: "static" },
]

function OpenShipMockPage(): React.JSX.Element {
  const { t } = useTranslation("openshipMock")
  const [category, setCategory] = React.useState<StackCategory>("fullstack")
  const [selectedFramework, setSelectedFramework] = React.useState("Next.js")
  const [location, setLocation] = React.useState("local")
  const [domainMode, setDomainMode] = React.useState("free")
  const visibleFrameworks = React.useMemo(
    () => frameworks.filter((framework) => framework.category === category),
    [category]
  )

  return (
    <main className="min-h-dvh min-w-[1180px] overflow-x-auto bg-white text-[#171717]">
      <div className="grid min-h-dvh grid-cols-[354px_minmax(620px,1fr)_468px] gap-11 p-4">
        <aside className="flex min-h-0 flex-col rounded-[22px] border border-[#ededed] bg-white px-4 py-5">
          <div className="flex h-20 items-center justify-between border-b border-[#f1f1f1] px-3 pb-5">
            <div className="flex items-center gap-3 text-xl font-semibold">
              <span className="size-9 rounded-full border-[4px] border-black" />
              OpenShip
            </div>
            <div className="flex gap-5 text-[#8e8e8e]">
              <RiMoonLine className="size-5" />
              <RiSidebarFoldLine className="size-5" />
            </div>
          </div>

          <nav className="mt-5 flex-1 space-y-7 px-3 text-[17px] text-[#8c8c8c]">
            <NavGroup label={t("nav.main")} items={[
              [RiDashboardLine, t("nav.home")],
              [RiFolder3Line, t("nav.projects")],
              [RiRocketLine, t("nav.deployments")],
            ]} />
            <NavGroup label={t("nav.settingsSection")} items={[[RiSettings3Line, t("nav.settings")]]} />
            <NavGroup label={t("nav.infrastructure")} items={[
              [RiServerLine, t("nav.servers")],
              [RiPulseLine, t("nav.monitoring")],
              [RiGlobalLine, t("nav.domains")],
            ]} />
          </nav>

          <button type="button" className="flex h-14 items-center justify-center gap-3 rounded-[20px] bg-gradient-to-r from-violet-500 to-blue-500 text-base font-semibold text-white shadow-sm">
            <RiAddLine className="size-5" /> {t("newProject")}
          </button>
          <div className="mt-4 border-t border-[#eeeeee] px-3 pt-5">
            <p className="text-xs font-semibold uppercase tracking-[.16em] text-[#b3b3b3]">{t("account")}</p>
            <div className="mt-4 flex items-center gap-3">
              <span className="grid size-12 place-items-center rounded-full bg-[#f0f0f0]">I</span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">Hydra-MacBook-Pro</p>
                <p className="text-sm text-[#969696]">{t("accountKind")}</p>
              </div>
              <RiLogoutBoxRLine className="size-5 text-[#8f8f8f]" />
            </div>
          </div>
        </aside>

        <section className="min-w-0 overflow-y-auto py-4 pr-1 [scrollbar-width:none]">
          <div className="rounded-[22px] border border-[#ededed] p-7">
            <div className="flex items-center justify-between">
              <h1 className="text-xl font-semibold">{t("framework.title")}</h1>
              <button type="button" className="flex items-center gap-2 text-sm font-medium">
                <span className="text-lg">✣</span>{t("framework.detected")}<RiArrowUpSLine className="size-4" />
              </button>
            </div>
            <div className="mt-5 flex w-fit rounded-2xl bg-[#f7f7f7] p-1">
              {STACK_CATEGORIES.map((key) => (
                <Segment
                  key={key}
                  active={category === key}
                  onClick={() => setCategory(key)}
                >
                  {t(`framework.${key}`)}
                </Segment>
              ))}
            </div>
            <div className="mt-5 grid grid-cols-6 gap-3">
              {visibleFrameworks.map((framework) => (
                <button
                  key={framework.name}
                  type="button"
                  onClick={() => setSelectedFramework(framework.name)}
                  className={`flex h-[120px] flex-col items-center justify-center gap-3 rounded-[22px] border bg-white ${selectedFramework === framework.name ? "border-black ring-1 ring-black" : "border-[#ededed]"}`}
                >
                  <span className={`grid size-11 place-items-center rounded-full text-xl font-bold ${framework.color}`}>{framework.mark}</span>
                  <span className="text-sm text-[#8f8f8f] first:text-black">{framework.name}</span>
                </button>
              ))}
            </div>
            <p className="mt-5 text-base text-[#a1a1a1]">{t("framework.help")}</p>
          </div>

          <div className="mt-7 overflow-hidden rounded-[22px] border border-[#ededed]">
            <div className="flex items-center justify-between border-b border-[#ededed] px-7 py-6">
              <div className="flex items-center gap-4">
                <span className="grid size-12 place-items-center rounded-full bg-orange-50 text-orange-500"><RiEqualizer2Line className="size-5" /></span>
                <div><h2 className="text-xl font-semibold">{t("config.title")}</h2><p className="text-sm text-[#a0a0a0]">{t("config.subtitle")}</p></div>
              </div>
              <RiArrowUpSLine className="size-5 text-[#999]" />
            </div>
            <div className="grid grid-cols-2 gap-6 p-7">
              <ConfigColumn icon={<RiHammerLine className="size-5" />} title={t("config.build")} subtitle={t("config.buildHelp")} fields={[
                [t("config.installCommand"), "npm i --force"],
                [t("config.buildCommand"), "npm run build"],
                [t("config.outputDirectory"), ".next"],
              ]} />
              <ConfigColumn icon={<RiPlayLine className="size-5" />} title={t("config.start")} subtitle={t("config.startHelp")} fields={[
                [t("config.startCommand"), "npm run start"],
                [t("config.productionPort"), "3000"],
              ]} />
            </div>
          </div>
        </section>

        <aside className="min-h-0 overflow-y-auto py-4 [scrollbar-width:none]">
          <div className="rounded-[22px] border border-[#ededed] p-6">
            <div className="mb-5 flex gap-3"><span className="size-3 rounded-full bg-red-300"/><span className="size-3 rounded-full bg-amber-200"/><span className="size-3 rounded-full bg-green-300"/></div>
            <div className="flex items-center gap-4 font-medium"><RiGithubLine className="size-5 text-[#8b8b8b]" /><span className="text-lg">Mo7ammedd/mdx-portofolio</span></div>
            <div className="mt-5 flex h-16 items-center gap-3 rounded-[20px] border border-[#ededed] px-5"><RiGitBranchLine className="size-5 text-[#777]"/><span className="flex-1 text-[#777]">main</span><span className="text-[#999]">⌄</span></div>
          </div>

          <div className="mt-6 rounded-[22px] border border-[#ededed] p-6">
            <p className="text-sm font-semibold uppercase tracking-wide text-[#8d8d8d]">{t("location.title")}</p>
            <div className="mt-4 grid grid-cols-2 rounded-[18px] border border-[#ededed] bg-[#fafafa] p-1">
              <Choice active={location === "server"} onClick={() => setLocation("server")} icon={<RiCloudLine className="size-5" />}>{t("location.server")}</Choice>
              <Choice active={location === "local"} onClick={() => setLocation("local")} icon={<RiComputerLine className="size-5" />}>{t("location.local")}</Choice>
            </div>
            <p className="mt-4 text-sm text-[#9d9d9d]">{t("location.help")}</p>
          </div>

          <div className="mt-6 overflow-hidden rounded-[22px] border border-[#ededed]">
            <div className="flex items-center gap-3 border-b border-[#ededed] px-6 py-5">
              <span className="grid size-10 place-items-center rounded-full bg-[#f1f1f1]"><RiGlobalLine className="size-5"/></span>
              <div><p className="font-semibold">{t("domain.title")}</p><p className="text-sm text-[#999]">{t("domain.subtitle")}</p></div>
            </div>
            <div className="p-6">
              <div className="grid grid-cols-2 rounded-[18px] bg-[#f4f4f4] p-1">
                <Segment active={domainMode === "free"} onClick={() => setDomainMode("free")}>{t("domain.free")}</Segment>
                <Segment active={domainMode === "custom"} onClick={() => setDomainMode("custom")}>{t("domain.custom")}</Segment>
              </div>
              <div className="mt-4 flex h-14 overflow-hidden rounded-[18px] border border-[#e8e8e8]"><span className="flex flex-1 items-center px-4">mdx-portofolio</span><span className="flex items-center border-l border-[#e8e8e8] bg-[#fafafa] px-4 font-medium">.opsh.io</span></div>
              <p className="mt-3 flex items-center gap-2 text-xs text-[#999]"><RiShieldCheckLine className="size-4 text-emerald-500" />{t("domain.ssl")} <strong className="font-medium text-[#555]">mdx-portofolio.opsh.io</strong></p>
            </div>
          </div>

          <button type="button" className="mt-5 flex h-16 w-full items-center justify-center gap-3 rounded-[22px] bg-[#171717] text-lg font-medium text-white"><RiRocketLine className="size-5" />{t("deploy")}</button>

          <div className="mt-5 rounded-[22px] border border-[#e8e8e8] bg-gradient-to-br from-white to-[#f7f7f7] p-6">
            <p className="text-sm font-semibold uppercase tracking-wide text-[#aaa]">{t("summary.title")}</p>
            <SummaryRow icon={<RiGlobalLine className="size-5" />} label={t("summary.domain")} value="mdx-portofolio.opsh.io" />
            <SummaryRow icon={<span className="grid size-9 place-items-center rounded-full bg-black text-white">N</span>} label={t("summary.framework")} value={selectedFramework} />
            <SummaryRow icon={<RiComputerLine className="size-5" />} label={t("summary.location")} value={t("summary.localMachine")} />
          </div>
        </aside>
      </div>
    </main>
  )
}

function NavGroup({ label, items }: { label: string; items: Array<[React.ElementType, string]> }): React.JSX.Element {
  return <div><p className="mb-4 text-xs font-semibold uppercase tracking-[.16em] text-[#b5b5b5]">{label}</p><div className="space-y-1">{items.map(([Icon, text]) => <div key={text} className="flex items-center gap-4 rounded-xl px-1 py-3"><Icon className="size-5"/><span>{text}</span></div>)}</div></div>
}

function Segment({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return <button type="button" onClick={onClick} className={`rounded-xl px-6 py-2.5 text-sm transition ${active ? "bg-white font-medium text-[#222] shadow-sm" : "text-[#949494]"}`}>{children}</button>
}

function Choice({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return <button type="button" onClick={onClick} className={`flex items-center justify-center gap-3 rounded-[14px] px-4 py-3 text-sm ${active ? "bg-white text-[#222] shadow-sm ring-1 ring-[#ededed]" : "text-[#969696]"}`}>{icon}{children}</button>
}

function ConfigColumn({ icon, title, subtitle, fields }: { icon: React.ReactNode; title: string; subtitle: string; fields: Array<[string, string]> }): React.JSX.Element {
  return <div><div className="flex h-[76px] items-center rounded-[20px] border border-[#ededed] px-5"><span className="mr-3 text-[#888]">{icon}</span><div className="flex-1"><p className="font-medium">{title}</p><p className="text-sm text-[#a0a0a0]">{subtitle}</p></div><span className="h-7 w-12 rounded-full bg-black p-1"><span className="block size-5 translate-x-5 rounded-full bg-white"/></span></div><div className="mt-5 space-y-5">{fields.map(([label, value]) => <label key={label} className="block"><span className="mb-2 block text-sm text-[#999]">{label}</span><span className="flex h-14 items-center rounded-[17px] border border-[#ededed] bg-[#fdfdfd] px-5 text-base">{value}</span></label>)}</div></div>
}

function SummaryRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }): React.JSX.Element {
  return <div className="mt-5 flex items-center gap-4"><span className="grid size-10 place-items-center rounded-full bg-[#ededed]">{icon}</span><div><p className="text-sm text-[#aaa]">{label}</p><p className="font-medium">{value}</p></div></div>
}
