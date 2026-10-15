// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Textarea } from "@workspace/ui/components/textarea"
import { createPageHead } from "../../../../../lib/page-metadata"
import {
  createSSOConfig,
  deleteSSOConfig,
  getSSOConfig,
  testSSOConnection,
  updateSSOConfig,
} from "../../../../../lib/sso"
import type {
  SSOConfigCreateBody,
  SSOConfigSummary,
  SSOConfigUpdateBody,
} from "@ploydok/shared"

export const Route = createFileRoute("/_authed/orgs/$orgSlug/settings/sso")({
  head: createPageHead("sso"),
  component: SSOSettingsPage,
})

function SSOSettingsPage() {
  const { orgSlug } = Route.useParams()

  const [config, setConfig] = useState<SSOConfigSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [formData, setFormData] = useState({
    issuer: "",
    client_id: "",
    client_secret: "",
    redirect_uri: "",
    scopes: "openid email profile",
  })

  const [showSecret, setShowSecret] = useState(false)
  const [testLoading, setTestLoading] = useState(false)

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const result = await getSSOConfig(orgSlug)
        if (result?.config) {
          setConfig(result.config)
          setFormData({
            issuer: result.config.issuer,
            client_id: result.config.client_id,
            client_secret: "",
            redirect_uri: result.config.redirect_uri,
            scopes: result.config.scopes,
          })
        }
      } catch (err) {
        setError("Failed to load SSO configuration")
      }
    }

    loadConfig()
  }, [orgSlug])

  const handleCreateOrUpdate = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setSuccess(null)

    try {
      if (config) {
        const updates: SSOConfigUpdateBody = {
          issuer: formData.issuer,
          client_id: formData.client_id,
          redirect_uri: formData.redirect_uri,
          scopes: formData.scopes,
        }
        if (formData.client_secret) {
          updates.client_secret = formData.client_secret
        }
        const result = await updateSSOConfig(orgSlug, updates)
        if (result) {
          setConfig(result.config)
          setSuccess("SSO configuration updated successfully")
        } else {
          setError("Failed to update SSO configuration")
        }
      } else {
        const body: SSOConfigCreateBody = {
          issuer: formData.issuer,
          client_id: formData.client_id,
          client_secret: formData.client_secret,
          redirect_uri: formData.redirect_uri,
          scopes: formData.scopes,
        }
        const result = await createSSOConfig(orgSlug, body)
        if (result) {
          setConfig(result.config)
          setFormData({ ...formData, client_secret: "" })
          setSuccess("SSO configuration created successfully")
        } else {
          setError("Failed to create SSO configuration")
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred")
    } finally {
      setLoading(false)
    }
  }

  const handleTest = async () => {
    setTestLoading(true)
    setError(null)

    try {
      const result = await testSSOConnection(orgSlug)
      if (result.ok) {
        setSuccess("OIDC configuration is valid")
      } else {
        setError(`Test failed: ${result.error || "Unknown error"}`)
      }
    } catch (err) {
      setError("Failed to test connection")
    } finally {
      setTestLoading(false)
    }
  }

  const handleDelete = async () => {
    if (
      !window.confirm("Are you sure you want to delete the SSO configuration?")
    ) {
      return
    }

    setLoading(true)
    setError(null)

    try {
      if (await deleteSSOConfig(orgSlug)) {
        setConfig(null)
        setFormData({
          issuer: "",
          client_id: "",
          client_secret: "",
          redirect_uri: "",
          scopes: "openid email profile",
        })
        setSuccess("SSO configuration deleted")
      } else {
        setError("Failed to delete SSO configuration")
      }
    } catch (err) {
      setError("An error occurred")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl leading-[26px] font-medium text-foreground">SSO Configuration</h1>
        <p className="mt-2 text-gray-600">
          Configure OIDC Single Sign-On for your organization
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert variant="default">
          <AlertDescription>{success}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>OIDC Configuration</CardTitle>
          <CardDescription>
            Enter your OIDC provider details to enable SSO for your organization
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreateOrUpdate} className="space-y-6">
            <div>
              <Label htmlFor="issuer">Issuer URL</Label>
              <Input
                id="issuer"
                type="url"
                placeholder="https://login.example.com"
                value={formData.issuer}
                onChange={(e) =>
                  setFormData({ ...formData, issuer: e.target.value })
                }
                required
              />
            </div>

            <div>
              <Label htmlFor="client_id">Client ID</Label>
              <Input
                id="client_id"
                placeholder="your-client-id"
                value={formData.client_id}
                onChange={(e) =>
                  setFormData({ ...formData, client_id: e.target.value })
                }
                required
              />
            </div>

            <div>
              <Label htmlFor="client_secret">Client Secret</Label>
              <div className="flex gap-2">
                <Input
                  id="client_secret"
                  type={showSecret ? "text" : "password"}
                  placeholder={config ? "(unchanged)" : "your-client-secret"}
                  value={formData.client_secret}
                  onChange={(e) =>
                    setFormData({ ...formData, client_secret: e.target.value })
                  }
                  required={!config}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowSecret(!showSecret)}
                >
                  {showSecret ? "Hide" : "Show"}
                </Button>
              </div>
            </div>

            <div>
              <Label htmlFor="redirect_uri">Redirect URI</Label>
              <Input
                id="redirect_uri"
                type="url"
                placeholder={`https://${window.location.hostname}/auth/sso/${orgSlug}/callback`}
                value={formData.redirect_uri}
                onChange={(e) =>
                  setFormData({ ...formData, redirect_uri: e.target.value })
                }
                required
              />
            </div>

            <div>
              <Label htmlFor="scopes">Scopes</Label>
              <Textarea
                id="scopes"
                placeholder="openid email profile"
                value={formData.scopes}
                onChange={(e) =>
                  setFormData({ ...formData, scopes: e.target.value })
                }
              />
            </div>

            <div className="flex gap-2">
              <Button type="submit" loading={loading}>
                {loading ? "Saving..." : config ? "Update" : "Create"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleTest}
                disabled={
                  testLoading || !formData.issuer || !formData.client_id
                }
              >
                {testLoading ? "Testing..." : "Test Connection"}
              </Button>
              {config && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={handleDelete}
                  loading={loading}
                >
                  Delete
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Configuration Instructions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div>
            <h3 className="mb-2 font-medium">Redirect URI</h3>
            <p className="mb-2 text-gray-600">
              Configure your OIDC provider to allow this redirect URI:
            </p>
            <code className="block rounded bg-gray-100 p-2">{`https://${window.location.hostname}/auth/sso/${orgSlug}/callback`}</code>
          </div>

          <div>
            <h3 className="mb-2 font-medium">Required Scopes</h3>
            <p className="mb-2 text-gray-600">
              Your OIDC provider must return the following claims:
            </p>
            <ul className="list-inside list-disc text-gray-600">
              <li>
                <code>email</code> — user email address (required for user
                lookup)
              </li>
              <li>
                <code>sub</code> — unique user identifier
              </li>
            </ul>
          </div>

          <div>
            <h3 className="mb-2 font-medium">User Provisioning</h3>
            <p className="text-gray-600">
              Only existing organization members can log in via SSO. A user must
              be invited to the organization before they can use SSO login.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
