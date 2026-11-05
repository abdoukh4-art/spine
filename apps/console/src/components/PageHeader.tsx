import { useEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { useDocumentTitle } from '../lib/hooks';

/** Props for {@link PageHeader}. */
export interface PageHeaderProps {
  title: string;
  /** Document title, when it should differ from the visible heading. */
  documentTitle?: string;
  description?: ReactNode;
  actions?: ReactNode;
}

/**
 * The page's `<h1>`, its document title, and focus management. After a client-side
 * navigation, focus moves to the heading so keyboard and screen-reader users land at
 * the start of the new content (instead of staying on the link they activated, which
 * no longer means anything). The very first page load keeps the browser default.
 */
export function PageHeader({ title, documentTitle, description, actions }: PageHeaderProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const { key, pathname } = useLocation();
  useDocumentTitle(documentTitle ?? title);

  useEffect(() => {
    // React Router gives the initial history entry the key "default".
    if (key !== 'default') heading.current?.focus();
    // Only the path matters: search-param changes (filters) must not steal focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <div className="sp-page-header">
      <div>
        <h1 ref={heading} tabIndex={-1} className="sp-page-header__title">
          {title}
        </h1>
        {description ? <div className="sp-page-header__desc">{description}</div> : null}
      </div>
      {actions ? <div className="sp-page-header__actions">{actions}</div> : null}
    </div>
  );
}
