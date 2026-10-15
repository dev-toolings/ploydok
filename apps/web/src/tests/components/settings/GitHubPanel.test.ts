// SPDX-License-Identifier: AGPL-3.0-only
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test"
import * as React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react"
import { invalidateGetCache, resetCsrfToken } from "../../../lib/api"

type CredentialsStatus =
  "not_configured" | "readable" | "unreadable" | undefined

let GitHubCredentialsRecovery: React.ComponentType<{
  unreadable: boolean
}>
let InstallationsCard: React.ComponentType<{
  role: "admin" | "member"
}>
let canLoadGitHubInstallations: (
  configured: boolean,
  status: CredentialsStatus
) => boolean
let shouldOpenGitHubCredentialsDialog: (
  status: CredentialsStatus,
  dismissed: boolean
) => boolean

const originalFetch = globalThis.fetch

describe("GitHubPanel credentials guard", () => {
  beforeAll(async () => {
    const module =
      await import("../../../components/settings/providers/GitHubPanel")
    GitHubCredentialsRecovery = module.GitHubCredentialsRecovery
    InstallationsCard = module.InstallationsCard
    canLoadGitHubInstallations = module.canLoadGitHubInstallations
    shouldOpenGitHubCredentialsDialog = module.shouldOpenGitHubCredentialsDialog
  })
  beforeEach(() => {
    invalidateGetCache()
    resetCsrfToken()
  })
  afterEach(() => {
    cleanup()
    invalidateGetCache()
    resetCsrfToken()
    globalThis.fetch = originalFetch
  })

  it("loads installations only for configured Apps with readable credentials", () => {
    expect(canLoadGitHubInstallations(true, "readable")).toBe(true)
    expect(canLoadGitHubInstallations(true, "unreadable")).toBe(false)
    expect(canLoadGitHubInstallations(true, undefined)).toBe(false)
    expect(canLoadGitHubInstallations(false, "readable")).toBe(false)
  })

  it("opens the recovery dialog once per visit for unreadable credentials", () => {
    expect(shouldOpenGitHubCredentialsDialog("unreadable", false)).toBe(true)
    expect(shouldOpenGitHubCredentialsDialog("unreadable", true)).toBe(false)
    expect(shouldOpenGitHubCredentialsDialog("readable", false)).toBe(false)
  })

  it("lets a member disconnect only their local link without offering installation", async () => {
    const requests: Array<{ url: string; method: string }> = []
    let installationGets = 0
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      const method = init?.method ?? "GET"
      requests.push({ url, method })
      if (url.endsWith("/auth/csrf")) {
        return Promise.resolve(
          new Response(JSON.stringify({ token: "csrf-token" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        )
      }
      if (url.endsWith("/github/installations/42") && method === "DELETE") {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, disconnected: 42 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        )
      }
      if (url.endsWith("/github/installations")) {
        installationGets += 1
        return Promise.resolve(
          new Response(
            JSON.stringify({
              installations: [
                {
                  id: 42,
                  accountLogin: "acme",
                  accountType: "Organization",
                  repositorySelection: "selected",
                  suspendedAt: null,
                  htmlUrl:
                    "https://github.com/organizations/acme/settings/installations/42",
                  avatarUrl: "",
                  repositoryCount: 3,
                },
              ],
              installUrl: "https://api.example.test/github/installations/start",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          )
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    queryClient.setQueryData(["git-providers", "status"], {
      github: { configured: true, connected: true },
    })
    const view = render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(InstallationsCard, { role: "member" })
      )
    )

    await waitFor(() => expect(view.getByText("@acme")).toBeTruthy())
    expect(
      view.queryByRole("button", { name: "Add account or organization" })
    ).toBeNull()
    expect(
      view.getByText(/administrator must add new accounts or organizations/)
    ).toBeTruthy()
    expect(view.getByRole("button", { name: "Disconnect" })).toBeTruthy()
    expect(view.queryByRole("button", { name: "Revoke" })).toBeNull()
    expect(view.queryByText("Cached repositories")).toBeNull()
    expect(view.queryByText("Sync now")).toBeNull()
    expect(view.getByTestId("github-installations-header").className).toContain(
      "flex-col"
    )
    expect(view.getByTestId("github-installations-header").className).toContain(
      "sm:flex-row"
    )

    fireEvent.click(view.getByRole("button", { name: "Disconnect" }))
    expect(
      await view.findByText("Disconnect GitHub installation?")
    ).toBeTruthy()
    expect(
      view.getByText(/does not uninstall the App or change any installation/)
    ).toBeTruthy()
    const disconnectButtons = view.getAllByRole("button", {
      name: "Disconnect",
    })
    fireEvent.click(disconnectButtons[disconnectButtons.length - 1])

    await waitFor(() => {
      expect(
        requests.some(
          ({ url, method }) =>
            url.endsWith("/github/installations/42") && method === "DELETE"
        )
      ).toBe(true)
      expect(installationGets).toBeGreaterThanOrEqual(2)
      expect(
        queryClient.getQueryState(["git-providers", "status"])?.isInvalidated
      ).toBe(true)
    })
    await waitFor(() =>
      expect(view.queryByText("Disconnect GitHub installation?")).toBeNull()
    )
  })

  it("keeps remote revoke and cache controls for administrators", async () => {
    const requests: Array<{ url: string; method: string }> = []
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      const method = init?.method ?? "GET"
      requests.push({ url, method })
      if (url.endsWith("/auth/csrf")) {
        return Promise.resolve(
          new Response(JSON.stringify({ token: "csrf-token" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        )
      }
      if (url.endsWith("/github/installations/42") && method === "DELETE") {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, revoked: 42 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        )
      }
      const body = url.endsWith("/github/installations/cache-status")
        ? { installations: [], staleThresholdMs: 900_000 }
        : {
            installations: [
              {
                id: 42,
                accountLogin: "acme",
                accountType: "Organization",
                repositorySelection: "all",
                suspendedAt: null,
                htmlUrl:
                  "https://github.com/organizations/acme/settings/installations/42",
                avatarUrl: "",
                repositoryCount: 3,
              },
            ],
            installUrl: "https://api.example.test/github/installations/start",
          }
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    }) as typeof fetch

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    const view = render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(InstallationsCard, { role: "admin" })
      )
    )

    await waitFor(() => expect(view.getByText("@acme")).toBeTruthy())
    expect(view.getByRole("button", { name: "Revoke" })).toBeTruthy()
    expect(view.queryByRole("button", { name: "Disconnect" })).toBeNull()
    expect(view.getByText("Cached repositories")).toBeTruthy()

    fireEvent.click(view.getByRole("button", { name: "Revoke" }))
    expect(await view.findByText("Revoke GitHub installation?")).toBeTruthy()
    expect(
      view.getByText(/uninstalls the Ploydok GitHub App from/)
    ).toBeTruthy()
    const revokeButtons = view.getAllByRole("button", { name: "Revoke" })
    fireEvent.click(revokeButtons[revokeButtons.length - 1])
    await waitFor(() =>
      expect(
        requests.some(
          ({ url, method }) =>
            url.endsWith("/github/installations/42") && method === "DELETE"
        )
      ).toBe(true)
    )
    await waitFor(() =>
      expect(view.queryByText("Revoke GitHub installation?")).toBeNull()
    )
  })

  it("opens the modal, keeps a warning after dismissal, and exposes reconnect", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
    const renderRecovery = (unreadable: boolean) =>
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(GitHubCredentialsRecovery, {
          unreadable,
        })
      )

    const view = render(renderRecovery(true))

    await waitFor(() =>
      expect(
        view.getByText("GitHub App credentials need attention")
      ).toBeTruthy()
    )
    const recoveryDialog = view
      .getByText("GitHub App credentials need attention")
      .closest('[data-slot="alert-dialog-content"]')
    expect(recoveryDialog?.className).toContain("w-[calc(100%-2rem)]")
    expect(recoveryDialog?.className).toContain("sm:max-w-2xl")
    for (const action of recoveryDialog?.querySelectorAll("button") ?? []) {
      expect(action.className).toContain("w-full")
      expect(action.className).toContain("whitespace-normal")
    }
    fireEvent.click(view.getByRole("button", { name: "Later" }))
    await waitFor(() =>
      expect(
        view.queryByText("GitHub App credentials need attention")
      ).toBeNull()
    )

    expect(view.getByRole("alert")).toBeTruthy()
    const requests: Array<{ url: string; body: string | null }> = []
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      requests.push({
        url,
        body: typeof init?.body === "string" ? init.body : null,
      })
      return Promise.resolve(
        new Response(
          JSON.stringify(
            url.endsWith("/auth/csrf")
              ? { token: "csrf-token" }
              : {
                  post_url: "https://github.com/settings/apps/new",
                  manifest: { name: "Ploydok" },
                }
          ),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    }) as typeof fetch
    const originalSubmit = HTMLFormElement.prototype.submit
    let submittedForm: HTMLFormElement | undefined
    HTMLFormElement.prototype.submit = function () {
      submittedForm = this
    }
    try {
      fireEvent.click(
        view.getByRole("button", { name: "Reconnect GitHub App" })
      )
      await waitFor(() =>
        expect(submittedForm?.action).toBe(
          "https://github.com/settings/apps/new"
        )
      )
      expect(
        requests.find(({ url }) => url.endsWith("/github/app/manifest"))?.body
      ).toBe(JSON.stringify({ return_to: "/settings/git-providers/github" }))
      expect(view.queryByLabelText("App ID")).toBeNull()
    } finally {
      HTMLFormElement.prototype.submit = originalSubmit
      submittedForm?.remove()
    }
    expect(view.queryByRole("button", { name: "Create GitHub App" })).toBeNull()

    view.rerender(renderRecovery(false))
    expect(view.queryByRole("alert")).toBeNull()
  })

  it("requires confirmation before resetting only the local configuration", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
    const view = render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(GitHubCredentialsRecovery, {
          unreadable: true,
        })
      )
    )

    await waitFor(() =>
      expect(
        view.getByText("GitHub App credentials need attention")
      ).toBeTruthy()
    )
    fireEvent.click(view.getByRole("button", { name: "Later" }))
    fireEvent.click(
      view.getByRole("button", { name: "Reset local configuration" })
    )

    expect(view.getByText("Reset local GitHub configuration?")).toBeTruthy()
    expect(
      view.getByText(/does not uninstall or delete the App on GitHub/)
    ).toBeTruthy()
    const resetDialog = view
      .getByText("Reset local GitHub configuration?")
      .closest('[data-slot="alert-dialog-content"]')
    expect(resetDialog?.className).toContain("w-[calc(100%-2rem)]")
    for (const action of resetDialog?.querySelectorAll("button") ?? []) {
      expect(action.className).toContain("w-full")
      expect(action.className).toContain("sm:w-auto")
    }

    fireEvent.click(view.getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(view.queryByText("Reset local GitHub configuration?")).toBeNull()
    )
    expect(view.getByRole("alertdialog")).toBeTruthy()
    expect(view.getByText("GitHub App credentials need attention")).toBeTruthy()
    expect(view.getByRole("alert", { hidden: true })).toBeTruthy()
  })

  it("keeps the reset confirmation open while pending and after an API error", async () => {
    let resolveReset: ((response: Response) => void) | undefined
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.endsWith("/auth/csrf")) {
        return Promise.resolve(
          new Response(JSON.stringify({ token: "csrf-token" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        )
      }
      return new Promise<Response>((resolve) => {
        resolveReset = resolve
      })
    }) as typeof fetch

    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
    const view = render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(GitHubCredentialsRecovery, {
          unreadable: true,
        })
      )
    )

    await waitFor(() =>
      expect(
        view.getByText("GitHub App credentials need attention")
      ).toBeTruthy()
    )
    fireEvent.click(view.getByRole("button", { name: "Later" }))
    fireEvent.click(
      view.getByRole("button", { name: "Reset local configuration" })
    )
    const resetButtons = view.getAllByRole("button", {
      name: "Reset local configuration",
    })
    fireEvent.click(resetButtons[resetButtons.length - 1])

    await waitFor(() =>
      expect(
        view.getByRole("button", {
          name: "Resetting local configuration...",
        })
      ).toBeTruthy()
    )
    expect(view.getByText("Reset local GitHub configuration?")).toBeTruthy()
    expect(
      (view.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)

    await act(async () => {
      resolveReset?.(
        new Response(
          JSON.stringify({
            error: {
              code: "GITHUB_APP_LOCAL_RESET_FAILED",
              message: "Could not reset the local GitHub App configuration",
            },
          }),
          {
            status: 409,
            headers: { "content-type": "application/json" },
          }
        )
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await waitFor(() =>
      expect(
        view.getByText("Could not reset the local GitHub App configuration")
      ).toBeTruthy()
    )
    expect(view.getByText("Reset local GitHub configuration?")).toBeTruthy()
  })
})
