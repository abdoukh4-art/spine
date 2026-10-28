import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { TEST_NOW } from './test/time';

// Freeze only `Date` (timers stay real, so user-event, polling and waitFor work normally).
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(TEST_NOW);

/*
 * jsdom does not implement HTMLDialogElement.showModal()/close(). This minimal polyfill
 * models the parts our Dialog relies on: the `open` attribute, the `close` event, and
 * Escape (the browser fires `cancel` then `close`). Real focus trapping is the browser's
 * job and is covered by the screenshots/e2e, not by jsdom.
 */
if (typeof HTMLDialogElement !== 'undefined' && !('showModal' in HTMLDialogElement.prototype)) {
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
      const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && this.open) {
          this.dispatchEvent(new Event('cancel'));
          this.close();
        }
      };
      this.ownerDocument.addEventListener('keydown', onKey);
      (this as unknown as { _escapeListener?: (e: KeyboardEvent) => void })._escapeListener = onKey;
    },
    show(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
    close(this: HTMLDialogElement) {
      if (!this.hasAttribute('open')) return;
      this.removeAttribute('open');
      const self = this as unknown as { _escapeListener?: (e: KeyboardEvent) => void };
      if (self._escapeListener)
        this.ownerDocument.removeEventListener('keydown', self._escapeListener);
      this.dispatchEvent(new Event('close'));
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'open', {
    get(this: HTMLDialogElement) {
      return this.hasAttribute('open');
    },
    configurable: true,
  });
}

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  window.localStorage.clear();
  document.title = '';
});
