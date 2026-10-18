// SPDX-License-Identifier: AGPL-3.0-only
import { createSerializationAdapter } from "@tanstack/react-router"
import { createStart } from "@tanstack/react-start"
import { ApiError } from "./lib/api/errors"

// SSR otherwise ships route errors to the client as a bare Error (message
// only): the error page loses the HTTP status and offers a retry on a 404.
const apiErrorAdapter = createSerializationAdapter({
  key: "ploydok-api-error",
  test: (value): value is ApiError => value instanceof ApiError,
  toSerializable: (error) => ({
    status: error.status,
    code: error.code,
    message: error.message,
    fields: error.fields ?? null,
    request: error.request
      ? {
          method: error.request.method,
          url: error.request.url,
          requestId: error.request.requestId ?? null,
        }
      : null,
  }),
  fromSerializable: (value) =>
    new ApiError(
      value.status,
      value.code,
      value.message,
      value.fields ?? undefined,
      value.request
        ? {
            method: value.request.method,
            url: value.request.url,
            requestId: value.request.requestId ?? undefined,
          }
        : undefined
    ),
})

export const startInstance = createStart(() => ({
  serializationAdapters: [apiErrorAdapter],
}))
