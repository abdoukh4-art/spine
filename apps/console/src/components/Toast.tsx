import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { IconButton } from './Button';
import { cx } from './cx';

/** One notification. */
export interface ToastMessage {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error';
}

interface ToastApi {
  /** Shows a toast that disappears after `durationMs` (default 6 s). */
  show: (message: string, tone?: ToastMessage['tone'], durationMs?: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Hosts toasts in a single, always-present `aria-live="polite"` region. The region must
 * exist **before** a message is inserted, or screen readers won't announce it; that's
 * why it's rendered once here rather than per toast.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);

  const show = useCallback<ToastApi['show']>(
    (message, tone = 'info', durationMs = 6000) => {
      const id = nextId.current++;
      setToasts((all) => [...all, { id, message, tone }]);
      window.setTimeout(() => dismiss(id), durationMs);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="sp-toasts" aria-live="polite" role="status" aria-label="Notifications">
        {toasts.map((toast) => (
          <div key={toast.id} className={cx('sp-toast', `sp-toast--${toast.tone}`)}>
            <span className="sp-toast__text">
              {toast.tone === 'error' ? 'Error: ' : ''}
              {toast.message}
            </span>
            <IconButton
              label="Dismiss notification"
              variant="ghost"
              size="sm"
              icon="✕"
              onClick={() => dismiss(toast.id)}
            />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Returns the toast API. Throws outside {@link ToastProvider}. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}
