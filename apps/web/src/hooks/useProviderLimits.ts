import type { ProviderLimitSnapshot, ProviderLimitsResponse } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

const POLL_INTERVAL_MS = 30_000;
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000] as const;

export function providerLimitsRetryDelay(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= RETRY_DELAYS_MS.length) return null;
  return RETRY_DELAYS_MS[attempt] ?? null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegative(value: unknown): number | null {
  const parsed = finite(value);
  return parsed === null ? null : Math.max(0, parsed);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function sanitizeSnapshot(value: unknown): ProviderLimitSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const instanceId = stringValue(raw.instanceId);
  const driver = stringValue(raw.driver);
  const updatedAt = stringValue(raw.updatedAt);
  if (
    !instanceId ||
    !driver ||
    !updatedAt ||
    (raw.source !== "provider-activity" && raw.source !== "provider-api")
  )
    return null;

  const windows = Array.isArray(raw.windows)
    ? raw.windows.flatMap((window) => {
        if (!window || typeof window !== "object" || Array.isArray(window)) return [];
        const item = window as Record<string, unknown>;
        const label = stringValue(item.label);
        const usedPercent = finite(item.usedPercent);
        if (!label || usedPercent === null) return [];
        const resetsAtMs = item.resetsAtMs === null ? null : nonNegative(item.resetsAtMs);
        if (item.resetsAtMs !== null && resetsAtMs === null) return [];
        return [{ label, usedPercent: Math.max(0, Math.min(100, usedPercent)), resetsAtMs }];
      })
    : [];

  const creditsRaw = raw.credits;
  const credits =
    creditsRaw && typeof creditsRaw === "object" && !Array.isArray(creditsRaw)
      ? {
          balance:
            (creditsRaw as Record<string, unknown>).balance === null
              ? null
              : stringValue((creditsRaw as Record<string, unknown>).balance),
          hasCredits: (creditsRaw as Record<string, unknown>).hasCredits === true,
          unlimited: (creditsRaw as Record<string, unknown>).unlimited === true,
        }
      : null;

  const spendRaw = raw.spendControl;
  const spendControl =
    spendRaw && typeof spendRaw === "object" && !Array.isArray(spendRaw)
      ? (() => {
          const item = spendRaw as Record<string, unknown>;
          const limit = stringValue(item.limit);
          const used = stringValue(item.used);
          const remainingPercent = finite(item.remainingPercent);
          const resetsAtMs = nonNegative(item.resetsAtMs);
          return limit && used && remainingPercent !== null && resetsAtMs !== null
            ? {
                limit,
                used,
                remainingPercent: Math.max(0, Math.min(100, remainingPercent)),
                resetsAtMs,
              }
            : null;
        })()
      : null;

  const status =
    raw.status === "allowed" || raw.status === "warning" || raw.status === "rejected"
      ? raw.status
      : null;
  const planType = raw.planType === null ? null : stringValue(raw.planType);

  return {
    instanceId,
    driver,
    windows,
    credits,
    spendControl,
    planType,
    status,
    updatedAt,
    source: raw.source,
  } as unknown as ProviderLimitSnapshot;
}

export function sanitizeProviderLimitsResponse(raw: unknown): ProviderLimitsResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Provider limits returned an invalid response");
  }
  const result = raw as Record<string, unknown>;
  const readAt = stringValue(result.readAt);
  if (!readAt || !Array.isArray(result.snapshots)) {
    throw new Error("Provider limits returned an incomplete response");
  }
  return {
    readAt,
    snapshots: result.snapshots.flatMap((snapshot) => {
      const parsed = sanitizeSnapshot(snapshot);
      return parsed ? [parsed] : [];
    }),
  };
}

export function useProviderLimits(enabled: boolean) {
  const [data, setData] = useState<ProviderLimitsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const failedAttemptsRef = useRef(0);
  const loadedRef = useRef(false);

  const fetchLimits = useCallback(async () => {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    if (!loadedRef.current) setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/provider/limits", { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const next = sanitizeProviderLimitsResponse(await response.json());
      setData(next);
      // An empty response is truthful, but can also mean the provider
      // registry/projection is still warming up. Give startup a bounded
      // chance to publish native telemetry before settling on that state.
      const retryDelay =
        next.snapshots.length === 0 ? providerLimitsRetryDelay(failedAttemptsRef.current) : null;
      if (retryDelay !== null && retryTimerRef.current === null) {
        failedAttemptsRef.current += 1;
        retryTimerRef.current = globalThis.setTimeout(() => {
          retryTimerRef.current = null;
          void fetchLimits();
        }, retryDelay);
      } else {
        if (retryTimerRef.current !== null) {
          globalThis.clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
        failedAttemptsRef.current = 0;
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setData(null);
      setError(cause instanceof Error ? cause.message : String(cause));

      const retryDelay = providerLimitsRetryDelay(failedAttemptsRef.current);
      failedAttemptsRef.current += 1;
      if (retryDelay !== null && retryTimerRef.current === null) {
        retryTimerRef.current = globalThis.setTimeout(() => {
          retryTimerRef.current = null;
          void fetchLimits();
        }, retryDelay);
      }
    } finally {
      loadedRef.current = true;
      if (requestRef.current === controller) requestRef.current = null;
      // Keep the loading state visible while a bounded retry is pending. This
      // prevents the UI from calling an in-flight retry "no telemetry".
      setLoading(retryTimerRef.current !== null);
    }
  }, []);

  const refetch = useCallback(() => {
    if (retryTimerRef.current !== null) {
      globalThis.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    failedAttemptsRef.current = 0;
    return fetchLimits();
  }, [fetchLimits]);

  useEffect(() => {
    if (!enabled) {
      requestRef.current?.abort();
      requestRef.current = null;
      if (retryTimerRef.current !== null) {
        globalThis.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      failedAttemptsRef.current = 0;
      loadedRef.current = false;
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    void fetchLimits();
    const interval = globalThis.setInterval(() => void fetchLimits(), POLL_INTERVAL_MS);
    return () => {
      requestRef.current?.abort();
      if (retryTimerRef.current !== null) {
        globalThis.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      globalThis.clearInterval(interval);
    };
  }, [enabled, fetchLimits]);

  return { data, loading, error, refetch };
}
