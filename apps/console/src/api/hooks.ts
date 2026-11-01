import { useEffect } from "react";

/**
 * Poll a refresh function on an interval. The console reads; polling pauses
 * while `paused` is true so an in-flight operator action is not clobbered by
 * a refetch landing mid-click.
 */
export function usePolling(intervalMs: number, refresh: () => Promise<void>, paused: boolean): void {
  useEffect(() => {
    if (paused) {
      return;
    }
    const timer = window.setInterval(() => {
      void refresh();
    }, intervalMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [intervalMs, refresh, paused]);
}
