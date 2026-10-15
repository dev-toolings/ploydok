// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test";
import { buildManifest } from "./manifest";

describe("buildManifest", () => {
  const opts = {
    webBaseUrl: "http://localhost:5173",
    apiBaseUrl: "http://localhost:3335",
  };

  it("sets name from web hostname", () => {
    const m = buildManifest(opts);
    expect(m.name).toBe("Ploydok (localhost)");
  });

  it("sets redirect_url to api callback", () => {
    const m = buildManifest(opts);
    expect(m.redirect_url).toBe("http://localhost:3335/github/app/callback");
  });

  it("sets callback_urls array", () => {
    const m = buildManifest(opts);
    expect(m.callback_urls).toEqual(["http://localhost:3335/github/app/callback"]);
  });

  it("omits hook_attributes on loopback apiBaseUrl (GitHub rejects localhost hooks)", () => {
    const m = buildManifest(opts);
    expect(m).not.toHaveProperty("hook_attributes");
    expect(m).not.toHaveProperty("default_events");
  });

  it("includes hook_attributes + default_events when apiBaseUrl is public", () => {
    const m = buildManifest({
      webBaseUrl: "https://ploydok.example.com",
      apiBaseUrl: "https://api.ploydok.example.com",
    }) as { hook_attributes: { url: string }; default_events: string[] };
    expect(m.hook_attributes.url).toBe("https://api.ploydok.example.com/github/webhook");
    expect(m.default_events).toContain("push");
    expect(m.default_events).toContain("pull_request");
  });

  it("uses explicit webhookUrl override (tunnel URL in local dev)", () => {
    const m = buildManifest({
      ...opts,
      webhookUrl: "https://abc123.ngrok.io/github/webhook",
    }) as { hook_attributes: { url: string } };
    expect(m.hook_attributes.url).toBe("https://abc123.ngrok.io/github/webhook");
  });

  it("sets public: false", () => {
    const m = buildManifest(opts);
    expect(m.public).toBe(false);
  });

  it("sets required default_permissions", () => {
    const m = buildManifest(opts);
    expect(m.default_permissions.contents).toBe("read");
    expect(m.default_permissions.deployments).toBe("write");
    expect(m.default_permissions.metadata).toBe("read");
    expect(m.default_permissions.pull_requests).toBe("read");
  });

  it("uses production base URLs correctly", () => {
    const m = buildManifest({
      webBaseUrl: "https://ploydok.example.com",
      apiBaseUrl: "https://api.ploydok.example.com",
    });
    expect(m.name).toBe("Ploydok (ploydok.example.com)");
    expect(m.redirect_url).toBe("https://api.ploydok.example.com/github/app/callback");
    expect(m.url).toBe("https://ploydok.example.com");
  });

  it("names an organization App within GitHub's 34-character limit", () => {
    const opts = {
      webBaseUrl: "http://192-168-1-235.sslip.io",
      apiBaseUrl: "http://192-168-1-235.sslip.io",
    };
    const m = buildManifest({ ...opts, ownerLogin: "dev-toolings" });
    expect(m.name).toMatch(/^Ploydok dev-toolings [0-9a-f]{6}$/);
    expect(buildManifest({ ...opts, ownerLogin: "dev-toolings" }).name).toBe(m.name);
    expect(
      buildManifest({ ...opts, webBaseUrl: "https://ploydok.example.com", ownerLogin: "dev-toolings" }).name,
    ).not.toBe(m.name);

    const long = buildManifest({ ...opts, ownerLogin: "a".repeat(39) });
    expect(long.name.length).toBeLessThanOrEqual(34);
    expect(long.name).toMatch(/^Ploydok a+ [0-9a-f]{6}$/);
  });
});
