// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { createPageHead } from "../../lib/page-metadata"
import { ShellPage } from "../../components/layout/AppShell";
import { apiBaseUrl } from "../../lib/api/base";
import { useGitHubAppConfig, useInstallations } from "../../lib/github";

export const Route = createFileRoute("/_authed/guide")({
  head: createPageHead("guide"),
  component: GuidePage,
});

function GuidePage(): React.JSX.Element {
  const { t } = useTranslation("settings");
  const { data: appConfig } = useGitHubAppConfig();
  const { data: installations } = useInstallations();
  const { apiOrigin, webOrigin } = usePublicOrigins();

  const installUrl = appConfig?.install_url ?? installations?.installUrl ?? `${apiOrigin}/github/installations/start`;
  const setupUrl = `${apiOrigin}/github/app/setup`;
  const callbackUrl = `${apiOrigin}/github/app/callback`;

  return (
    <ShellPage
      title={t("guide.title")}
      description={t("guide.description")}
      eyebrow={t("onboarding:guide.eyebrow")}
    >
      <div className="space-y-8">
        <header className="rounded-2xl bg-panel p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl space-y-3">
              <p className="text-xs font-semibold text-primary">{t("onboarding:guide.operational")}</p>
              <h1 className="text-xl leading-[26px] font-medium text-foreground">{t("onboarding:guide.heading")}</h1>
              <p className="text-sm leading-6 text-muted-foreground">
                {t("onboarding:guide.intro")}
              </p>
            </div>

            <div className="grid min-w-[280px] gap-3 rounded-xl border border-border bg-background p-4 text-sm">
              <StatusRow label={t("onboarding:guide.appCreated")} value={appConfig?.configured ? t("onboarding:guide.yes") : t("onboarding:guide.no")} />
              <StatusRow
                label={t("onboarding:guide.activeInstalls")}
                value={String(installations?.installations.length ?? 0)}
              />
              <StatusRow label={t("onboarding:guide.expectedSetup")} value={setupUrl} mono />
              <StatusRow label={t("onboarding:guide.expectedCallback")} value={callbackUrl} mono />
            </div>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-3">
          <QuickCard
            title="1. Create the App"
            body="Use Settings > GitHub in Ploydok, then click Create GitHub App. Ploydok posts a manifest to GitHub."
            ctaLabel="Open GitHub settings"
            to="/settings/git-providers/$slug" params={{ slug: "github" }}
          />
          <QuickCard
            title="2. Install the App"
            body="From Settings > GitHub, use Install on GitHub. Ploydok now starts through the API with a signed state."
            href={installUrl}
            ctaLabel="Open install flow"
          />
          <QuickCard
            title="3. Confirm the return"
            body="After Install, GitHub must return to /github/app/setup, then Ploydok must land back on /settings/git-providers/github."
            ctaLabel="Review expected URLs"
            to="#expected"
          />
        </section>

        <GuideSection
          eyebrow="Preparation"
          title="Before you click anything"
          description="These values must be correct before you create or recreate the GitHub App."
        >
          <Checklist
            items={[
              `\`WEB_ORIGIN\` must be \`${webOrigin}\` in the API environment.`,
              `\`GITHUB_APP_CALLBACK_URL\` should resolve to \`${callbackUrl}\`.`,
              "The API origin and web origin must match what users can reach from their browser.",
              "If you changed callback or setup URLs after the app was already created, recreate the GitHub App or update its settings manually in GitHub.",
            ]}
          />
          <WhatYouShouldSee
            title="What you should see in Ploydok"
            lines={[
              "Settings > GitHub shows either an unconfigured state with Create GitHub App, or a configured state with the app name and install link.",
              "If the app already exists but install return is broken, use this guide before assuming the frontend is at fault.",
            ]}
          />
        </GuideSection>

        <GuideSection
          eyebrow="Step 1"
          title="Create the GitHub App from Ploydok"
          description="Ploydok creates a GitHub App manifest, GitHub converts it into a real app, then redirects back to Ploydok."
        >
          <ol className="space-y-3 text-sm leading-6 text-foreground">
            <li>1. Open <Link to="/settings/git-providers/$slug" params={{ slug: "github" }} className="text-primary underline-offset-2 hover:underline">Settings {"->"} GitHub</Link>.</li>
            <li>2. Click <strong>Create GitHub App</strong>.</li>
            <li>3. GitHub opens the App creation form with the manifest already injected.</li>
            <li>4. Confirm the creation on GitHub.</li>
            <li>5. GitHub redirects to the callback URL, and Ploydok stores the generated app credentials.</li>
          </ol>

          <Callout tone="neutral" title="Expected result">
            You should land back on <code>/settings/git-providers/github?app=created</code> with a green success state in Ploydok.
          </Callout>

          <CodeBlock
            title="Expected app configuration in GitHub"
            lines={[
              `Homepage URL: ${webOrigin}`,
              `Callback URL: ${callbackUrl}`,
              `Setup URL: ${setupUrl}`,
              "Request user authorization (OAuth) during installation: disabled",
            ]}
          />
        </GuideSection>

        <GuideSection
          eyebrow="Step 2"
          title="Install the GitHub App on your account or organization"
          description="The install button should not send you straight to a static GitHub URL anymore. It should go through the API start route first."
        >
          <ol className="space-y-3 text-sm leading-6 text-foreground">
            <li>1. From <Link to="/settings/git-providers/$slug" params={{ slug: "github" }} className="text-primary underline-offset-2 hover:underline">Settings {"->"} GitHub</Link>, click <strong>Install on GitHub</strong>.</li>
            <li>2. Ploydok redirects to <code>{installUrl}</code>.</li>
            <li>3. The API creates a signed state cookie, then redirects to GitHub <code>installations/new</code>.</li>
            <li>4. On GitHub, choose the target account or organization, then choose repository access.</li>
            <li>5. Click <strong>Install</strong>.</li>
          </ol>

          <WhatYouShouldSee
            title="What you should see on GitHub"
            lines={[
              "A permissions page under github.com/apps/<your-app-slug>/installations/new/permissions",
              "An Install button at the bottom",
              "After clicking Install, GitHub should leave github.com and hit the setup URL configured on the app",
            ]}
          />

          <Callout tone="warn" title="If you stay on GitHub with “Successfully installed”">
            The GitHub App settings are still wrong. The usual cause is that <code>Request user authorization (OAuth) during installation</code> is enabled or the app was created before the correct setup URL existed.
          </Callout>
        </GuideSection>

        <GuideSection
          eyebrow="Step 3"
          title="Verify the callback and return to Ploydok"
          description="This is the critical part of the flow. GitHub must call the setup URL and Ploydok must validate the state before redirecting back to the UI."
        >
          <CodeBlock
            title="Expected redirect chain"
            lines={[
              `1. ${installUrl}`,
              "2. https://github.com/apps/<slug>/installations/new?state=<signed-state>",
              `3. ${setupUrl}?installation_id=...&setup_action=install&state=...`,
              `4. ${webOrigin}/settings/git-providers/github?installation_id=...&setup_action=install&installed=1`,
            ]}
          />

          <WhatYouShouldSee
            title="What you should see back in Ploydok"
            lines={[
              "A success banner mentioning the installation id",
              "The installations list refreshes",
              "The new GitHub account or organization appears in Active installations",
            ]}
          />

          <Callout tone="neutral" title="Why Ploydok now uses a signed state">
            The setup callback validates that the install flow really started from Ploydok. Invalid or expired state now produces a clear error banner instead of a silent or confusing return.
          </Callout>
        </GuideSection>

        <GuideSection
          eyebrow="Troubleshooting"
          title="When the install flow is still broken"
          description="Use this list in order. Do not start by debugging the sidebar or TanStack Router; most failures here are GitHub App configuration issues."
        >
          <Checklist
            items={[
              `Open the GitHub App settings and confirm \`Setup URL\` is exactly \`${setupUrl}\`.`,
              "Confirm `Request user authorization (OAuth) during installation` is disabled.",
              `Confirm the callback URL is still \`${callbackUrl}\`.`,
              "If the app was created before these values were fixed, recreate the app from Ploydok or update the GitHub App settings manually.",
              "If the setup callback returns to Ploydok with `install_error=state_mismatch`, restart the install flow from Ploydok instead of reusing an old GitHub tab.",
              "If Ploydok shows the app as configured but no installation appears, use the Refresh button on Settings > GitHub and check whether the install landed on the expected account.",
            ]}
          />

          <div className="grid gap-4 lg:grid-cols-2">
            <CodeBlock
              title="Good local values"
              lines={[
                `WEB_ORIGIN=${webOrigin}`,
                `GITHUB_APP_CALLBACK_URL=${callbackUrl}`,
              ]}
            />
            <CodeBlock
              title="Common bad state"
              lines={[
                "Setup URL missing",
                "OAuth-on-install enabled",
                "Old app created before callback/setup URLs were corrected",
              ]}
            />
          </div>
        </GuideSection>

        <section id="expected" className="rounded-2xl bg-panel p-6">
          <h2 className="text-base font-medium">Expected URLs reference</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Keep these values aligned between the API environment, the manifest flow, and the GitHub App settings page.
          </p>
          <div className="mt-4 grid gap-3 text-sm">
            <StatusRow label="Ploydok web origin" value={webOrigin} mono />
            <StatusRow label="Ploydok API origin" value={apiOrigin} mono />
            <StatusRow label="GitHub App callback" value={callbackUrl} mono />
            <StatusRow label="GitHub App setup URL" value={setupUrl} mono />
            <StatusRow label="Install start URL" value={installUrl} mono />
          </div>
        </section>
      </div>
    </ShellPage>
  );
}

function usePublicOrigins(): { apiOrigin: string; webOrigin: string } {
  const [origins, setOrigins] = React.useState({
    apiOrigin: "https://<your-instance>",
    webOrigin: "https://<your-instance>",
  });

  React.useEffect(() => {
    const base = apiBaseUrl().replace(/\/$/, "");
    const webOrigin = window.location.origin;
    const apiOrigin = /^https?:\/\//.test(base) ? base : webOrigin;
    setOrigins({ apiOrigin, webOrigin });
  }, []);

  return origins;
}

function GuideSection({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="rounded-2xl bg-panel p-6">
      <p className="text-xs font-semibold text-primary">{eyebrow}</p>
      <h2 className="mt-2 text-xl font-medium">{title}</h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
      <div className="mt-5 space-y-5">{children}</div>
    </section>
  );
}

function QuickCard({
  title,
  body,
  ctaLabel,
  to,
  params,
  href,
}: {
  title: string;
  body: string;
  ctaLabel: string;
  to?: string;
  params?: Record<string, string>;
  href?: string;
}): React.JSX.Element {
  const linkProps = to
    ? ({ to, ...(params ? { params } : {}) } as Parameters<typeof Link>[0])
    : null;
  return (
    <div className="rounded-2xl bg-panel p-5">
      <h2 className="text-base font-medium">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
      <div className="mt-4">
        {to?.startsWith("#") ? (
          <a href={to} className="text-sm font-medium text-primary underline-offset-2 hover:underline">
            {ctaLabel}
          </a>
        ) : linkProps ? (
          <Link {...linkProps} className="text-sm font-medium text-primary underline-offset-2 hover:underline">
            {ctaLabel}
          </Link>
        ) : href ? (
          <a href={href} className="text-sm font-medium text-primary underline-offset-2 hover:underline">
            {ctaLabel}
          </a>
        ) : null}
      </div>
    </div>
  );
}

function StatusRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/70 bg-card px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-xs break-all" : "text-sm font-medium"}>{value}</span>
    </div>
  );
}

function Checklist({ items }: { items: Array<string> }): React.JSX.Element {
  return (
    <ul className="grid gap-3">
      {items.map((item) => (
        <li key={item} className="flex items-start gap-3 rounded-xl border border-border/70 bg-background px-4 py-3 text-sm leading-6">
          <span className="mt-1 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            ✓
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function WhatYouShouldSee({
  title,
  lines,
}: {
  title: string;
  lines: Array<string>;
}): React.JSX.Element {
  return (
    <div className="rounded-2xl border border-dashed border-panel-border bg-panel-inset p-5">
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {lines.map((line, index) => (
          <div key={line} className="rounded-2xl bg-panel p-4">
            <p className="text-[11px] font-semibold text-muted-foreground">Screen {index + 1}</p>
            <p className="mt-2 text-sm leading-6 text-foreground">{line}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Callout({
  tone,
  title,
  children,
}: {
  tone: "neutral" | "warn";
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const className =
    tone === "warn"
      ? "border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-amber-100"
      : "border-border bg-background text-foreground";

  return (
    <div className={`rounded-2xl border p-4 ${className}`}>
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="mt-2 text-sm leading-6">{children}</div>
    </div>
  );
}

function CodeBlock({
  title,
  lines,
}: {
  title: string;
  lines: Array<string>;
}): React.JSX.Element {
  return (
    <div className="rounded-2xl border border-border bg-zinc-950 p-4 text-zinc-50">
      <h3 className="text-sm font-medium text-zinc-100">{title}</h3>
      <pre className="mt-3 overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-6 text-zinc-300">
        {lines.join("\n")}
      </pre>
    </div>
  );
}
