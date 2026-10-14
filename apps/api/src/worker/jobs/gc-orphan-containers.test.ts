// SPDX-License-Identifier: AGPL-3.0-only
import { expect, mock, test } from "bun:test"
import type { Db } from "@ploydok/db"
const remove = mock(async () => ({}))
mock.module("../../debug/singletons", () => ({
  getSharedAgent: () => ({
    listContainers: async ({ kindFilter }: { kindFilter: string }) => ({
      containers:
        kindFilter === "service"
          ? [
              {
                id: "old",
                name: "orphan-service",
                kind: "service",
                serviceId: "gone",
                uptimeS: 90_000,
              },
              {
                id: "live",
                name: "live-service",
                kind: "service",
                serviceId: "live",
                uptimeS: 90_000,
              },
              {
                id: "young",
                name: "young-service",
                kind: "service",
                serviceId: "gone",
                uptimeS: 10,
              },
            ]
          : [],
    }),
    containerRemove: remove,
  }),
}))
const { runOrphanContainerGc } = await import("./gc-orphan-containers")
test("service GC removes only old containers without a durable service owner", async () => {
  let selects = 0
  const db = {
    select: () => ({
      from: async () => (++selects === 3 ? [{ id: "live" }] : []),
    }),
  } as unknown as Db
  const result = await runOrphanContainerGc(db)
  expect(result.removed).toEqual(["orphan-service"])
  expect(remove).toHaveBeenCalledTimes(1)
  expect(remove).toHaveBeenCalledWith({
    containerId: "old",
    force: true,
    removeVolumes: false,
  })
})
