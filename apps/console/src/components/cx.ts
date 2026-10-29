/** Joins truthy class names: `cx('a', cond && 'b')`. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}
