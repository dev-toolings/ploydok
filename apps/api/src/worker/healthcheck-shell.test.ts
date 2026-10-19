// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from "bun:test"
import { healthcheckTest } from "./healthcheck-shell"

it("requests the native health gate with literal arguments and no caller-provided shell code", () => {
  const path = `/ready path/'"$(printf ready)`
  expect(healthcheckTest(8080, path)).toEqual(["PLOYDOK-HTTP", "8080", path])
})
