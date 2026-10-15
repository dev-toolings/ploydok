// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"

import { repairMojibake } from "./text-repair"

describe("repairMojibake", () => {
  it("restores UTF-8 text decoded as windows-1252", () => {
    expect(repairMojibake("ðŸ—‚ï¸\u008fA file list")).toBe("🗂️A file list")
    expect(repairMojibake("Huly â€” All-in-One")).toBe("Huly — All-in-One")
    expect(repairMojibake("PhotoPrismÂ® app")).toBe("PhotoPrism® app")
  })

  it("leaves correct text untouched", () => {
    expect(repairMojibake("plain ascii")).toBe("plain ascii")
    expect(repairMojibake("Déjà vu — ça marche")).toBe("Déjà vu — ça marche")
  })
})
