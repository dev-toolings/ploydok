// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"

import { formatTemplateVersion } from "./marketplace"

describe("formatTemplateVersion", () => {
  it("prefixes numeric versions with a single v", () => {
    expect(formatTemplateVersion("1.9")).toBe("v1.9")
    expect(formatTemplateVersion("v3.55.0")).toBe("v3.55.0")
    expect(formatTemplateVersion("V1")).toBe("v1")
  })

  it("keeps non-numeric tags as is", () => {
    expect(formatTemplateVersion("latest")).toBe("latest")
    expect(formatTemplateVersion("stable")).toBe("stable")
  })
})
