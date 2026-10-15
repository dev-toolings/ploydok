// SPDX-License-Identifier: AGPL-3.0-only
import {
  
  useMutation,
  useQuery,
  useQueryClient
} from "@tanstack/react-query";
import { useMatch } from "@tanstack/react-router";
import { toast } from "sonner";
import { apiFetch, criticalRetryDelay, shouldRetryCriticalQuery } from "./api";
import i18n from "./i18n";
import type { ApiError} from "./api";
import type {UseQueryResult} from "@tanstack/react-query";
import type { Me } from "@ploydok/shared";

// ---------------------------------------------------------------------------
// useMe
// ---------------------------------------------------------------------------

export function useMe(): UseQueryResult<Me, ApiError> {
  return useQuery<Me, ApiError>({
    queryKey: ["me"],
    queryFn: () => apiFetch<Me>("/me"),
    // Dédup : une seule fetch partagée entre tous les composants, refetch
    // après 1 min d'inactivité seulement.
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: shouldRetryCriticalQuery,
    retryDelay: criticalRetryDelay,
    meta: { critical: true },
  });
}

/**
 * The signed-in user under `_authed`: the `/me` query once loaded, else the
 * user the route guard already fetched for this request. Server render and
 * first client render read the same request-scoped value, so the shell paints
 * once instead of waiting for a second `/me` round trip.
 */
export function useSessionMe(): Me | undefined {
  const { data } = useMe();
  const authed = useMatch({ from: "/_authed", shouldThrow: false });
  return data ?? authed?.context.me;
}

// ---------------------------------------------------------------------------
// useLogin — passkey sign-in
// ---------------------------------------------------------------------------

interface LoginPayload {
  credential: unknown;
  _challengeKey: string;
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation<Me, ApiError, LoginPayload>({
    mutationFn: (payload) =>
      apiFetch<Me>("/auth/login/verify", { method: "POST", body: payload }),
    onSuccess: (data) => {
      toast.success(i18n.t("auth:login.signedIn"));
      qc.setQueryData(["me"], data);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
}

// ---------------------------------------------------------------------------
// useRegister — passkey registration verify
// ---------------------------------------------------------------------------

interface RegisterPayload {
  userId: string;
  credential: unknown;
  device_name?: string;
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation<Me, ApiError, RegisterPayload>({
    mutationFn: (payload) =>
      apiFetch<Me>("/auth/register/verify", { method: "POST", body: payload }),
    onSuccess: (data) => {
      toast.success(i18n.t("auth:accountCreated"));
      qc.setQueryData(["me"], data);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
}

// ---------------------------------------------------------------------------
// useLogout
// ---------------------------------------------------------------------------

export function useLogout() {
  const qc = useQueryClient();
  return useMutation<void, ApiError, void>({
    mutationFn: () => apiFetch<void>("/auth/logout", { method: "POST" }),
    onSuccess: () => {
      toast.success(i18n.t("auth:signedOut"));
      qc.setQueryData(["me"], null);
      qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
}
