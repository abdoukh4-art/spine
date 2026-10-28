import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

/** One tab and its panel. */
export interface TabItem {
  id: string;
  label: string;
  content: ReactNode;
}

/** Props for {@link Tabs}. Controlled when `selectedId` + `onSelect` are given. */
export interface TabsProps {
  /** Accessible name of the tab list. */
  label: string;
  tabs: readonly TabItem[];
  selectedId?: string;
  onSelect?: (id: string) => void;
}

/**
 * WAI-ARIA APG tabs with automatic activation. Only the selected tab is in the Tab order
 * (roving tabindex); ←/→ move between tabs, Home/End jump to the ends.
 */
export function Tabs({ label, tabs, selectedId, onSelect }: TabsProps) {
  const [internal, setInternal] = useState(tabs[0]?.id ?? '');
  const current = selectedId ?? internal;
  const baseId = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());

  const select = (id: string) => {
    if (selectedId === undefined) setInternal(id);
    onSelect?.(id);
    refs.current.get(id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = nextTabIndex(event.key, index, tabs.length);
    if (target === null) return;
    event.preventDefault();
    const tab = tabs[target];
    if (tab) select(tab.id);
  };

  const active = tabs.find((t) => t.id === current) ?? tabs[0];
  return (
    <div className="sp-tabs">
      <div role="tablist" aria-label={label} className="sp-tabs__list">
        {tabs.map((tab, index) => {
          const selected = tab.id === active?.id;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                if (el) refs.current.set(tab.id, el);
                else refs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              className="sp-tabs__tab"
              onClick={() => select(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {active ? (
        <div
          role="tabpanel"
          id={`${baseId}-panel-${active.id}`}
          aria-labelledby={`${baseId}-tab-${active.id}`}
          tabIndex={0}
          className="sp-tabs__panel"
        >
          {active.content}
        </div>
      ) : null}
    </div>
  );
}

/** Index of the tab a key press moves to (wrapping), or null for keys we don't handle. */
export function nextTabIndex(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
