import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Polls `fetcher` on an interval. Pauses while the tab is hidden so a phone left
 * in a pocket does not hammer the API, and refetches immediately on return.
 * `silent` reloads do not flip `loading`, so the list never flickers under the
 * user's thumb mid-refresh.
 */
export function usePoll(fetcher, intervalMs, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
      return result;
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    const tick = async () => {
      if (cancelled || document.hidden) return;
      try {
        await load({ silent: true });
      } catch (err) {
        /* keep polling — transient network errors are expected at a gate */
      }
    };

    load({ silent: false }).catch(() => {});
    timer = setInterval(tick, intervalMs);

    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload: load, setData };
}
