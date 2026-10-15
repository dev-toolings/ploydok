// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import { apps, builds } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { backfillAppDomainMetadata } from "./app-domain"

describe("backfillAppDomainMetadata", () => {
  it("classifies legacy domains and snapshots the latest active build", async () => {
    const appUpdates: Array<Record<string, unknown>> = []
    const buildUpdates: Array<Record<string, unknown>> = []
    let selectCount = 0
    const db = {
      select() {
        selectCount++
        return {
          from(table: unknown) {
            return {
              where() {
                const rows =
                  table === apps
                    ? [
                        {
                          id: "app-1",
                          domain: "custom.example.com",
                          domain_source: "generated",
                          status: "running",
                          routing_status: "action_required",
                          routing_error: "Routing state must be rechecked after migration",
                          routing_dns_status: null,
                          routing_tls_status: null,
                        },
                      ]
                    : [{ id: "build-1" }]
                const queryRows = rows as unknown as Array<Record<string, unknown>> & {
                  orderBy: () => { limit: () => Promise<unknown> }
                  limit: () => Promise<unknown>
                }
                queryRows.orderBy = () => ({ limit: async () => rows })
                queryRows.limit = async () => rows
                return queryRows
              },
            }
          },
        }
      },
      update(table: unknown) {
        return {
          set(values: Record<string, unknown>) {
            return {
              where() {
                if (table === apps) appUpdates.push(values)
                else buildUpdates.push(values)
                return {
                  returning: async () => [{ id: "build-1" }],
                }
              },
            }
          },
        }
      },
    } as unknown as Db

    const outcome = await backfillAppDomainMetadata(db, "apps.example.com")
    expect(outcome).toEqual({ appsUpdated: 1, buildsUpdated: 1 })
    expect(selectCount).toBe(2)
    expect(appUpdates).toEqual([
      {
        domain_source: "custom",
      },
    ])
    expect(buildUpdates).toEqual([{ routing_domain: "custom.example.com" }])
  })
})
