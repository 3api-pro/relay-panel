"use client";
import { useEffect, useRef, useState, useCallback } from "react";

export interface UseAutoRefreshOptions {
  /** Poll interval in ms while the document is visible. Default 30_000. */
  intervalMs?: number;
  /** Refetch on window focus. Default true. */
  refetchOnFocus?: boolean;
  /** Re-fetch immediately when document becomes visible. Default true. */
  refetchOnVisibility?: boolean;
  /** Gate the whole hook (disable for SSR or feature flag). Default true. */
  enabled?: boolean;
}

export interface UseAutoRefreshResult<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** Last successful refresh timestamp (ms). null until first success. */
  lastRefreshed: number | null;
  /** Manual refetch — bypasses visibility gate. */
  refetch: () => Promise<void>;
}

/**
 * Lightweight polling hook with visibility + focus awareness.
 *
 * - First fetch fires on mount (regardless of visibility).
 * - Interval ticks ONLY when the document is visible (avoids burning quota in
 *   background tabs).
 * - On `visibilitychange` -> visible, fires an immediate refresh.
 * - On window focus, fires an immediate refresh (configurable).
 */
export function useAutoRefresh<T>(
  fetcher: () => Promise<T>,
  opts: UseAutoRefreshOptions = {},
): UseAutoRefreshResult<T> {
  const {
    intervalMs = 30_000,
    refetchOnFocus = true,
    refetchOnVisibility = true,
    enabled = true,
  } = opts;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null);

  // Keep latest fetcher in a ref so we never re-bind the interval.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Track whether the component is still mounted to avoid setState-after-unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    try {
      const d = await fetcherRef.current();
      if (!mountedRef.current) return;
      setData(d);
      setError(null);
      setLastRefreshed(Date.now());
    } catch (e: any) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // First load.
    run();

    if (typeof window === "undefined") return;

    const tick = () => {
      if (document.visibilityState === "visible") run();
    };
    const id = window.setInterval(tick, intervalMs);

    const onFocus = () => {
      if (refetchOnFocus) run();
    };
    const onVisibility = () => {
      if (refetchOnVisibility && document.visibilityState === "visible") run();
    };

    if (refetchOnFocus) window.addEventListener("focus", onFocus);
    if (refetchOnVisibility) document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(id);
      if (refetchOnFocus) window.removeEventListener("focus", onFocus);
      if (refetchOnVisibility) document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs, refetchOnFocus, refetchOnVisibility, run]);

  return { data, error, loading, lastRefreshed, refetch: run };
}
