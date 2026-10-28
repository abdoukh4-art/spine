import { useEffect, useState } from 'react';

/** Suffix of every document title. */
export const TITLE_SUFFIX = 'Spine';

/** Sets `document.title` to `<title> · Spine` while the calling page is mounted. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · ${TITLE_SUFFIX}`;
  }, [title]);
}

/** Current time (epoch ms), re-rendering every `intervalMs`. Used by countdowns. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
