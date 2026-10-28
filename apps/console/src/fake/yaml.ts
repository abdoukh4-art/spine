/**
 * A tiny YAML *emitter* for plain JSON data, used only to show fixture playbooks as the
 * YAML an author would have written. It handles maps, sequences and scalars, which is
 * all a playbook definition contains. It is not a general YAML library.
 */
export function toYaml(value: unknown, indent = 0): string {
  return emit(value, indent).join('\n') + '\n';
}

const pad = (n: number) => ' '.repeat(n);

function scalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  // Quote anything YAML could misread (numbers, booleans, special characters, empty).
  const plain =
    /^[A-Za-z_/][A-Za-z0-9 _./-]*$/.test(text) && !/^(true|false|null|yes|no|on|off)$/i.test(text);
  return plain && !text.endsWith(' ') ? text : JSON.stringify(text);
}

function isEmptyContainer(value: unknown): boolean {
  return (
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && value !== null && Object.keys(value).length === 0)
  );
}

function emit(value: unknown, indent: number): string[] {
  if (Array.isArray(value)) return emitSequence(value as unknown[], indent);
  if (typeof value === 'object' && value !== null) {
    return emitMap(value as Record<string, unknown>, indent);
  }
  return [pad(indent) + scalar(value)];
}

function emitMap(map: Record<string, unknown>, indent: number): string[] {
  const lines: string[] = [];
  for (const [key, child] of Object.entries(map)) {
    if (child === undefined) continue;
    if (isEmptyContainer(child)) {
      lines.push(`${pad(indent)}${key}: ${Array.isArray(child) ? '[]' : '{}'}`);
    } else if (typeof child === 'object' && child !== null) {
      lines.push(`${pad(indent)}${key}:`);
      lines.push(...emit(child, Array.isArray(child) ? indent : indent + 2));
    } else {
      lines.push(`${pad(indent)}${key}: ${scalar(child)}`);
    }
  }
  return lines;
}

function emitSequence(items: unknown[], indent: number): string[] {
  const lines: string[] = [];
  for (const item of items) {
    if (typeof item === 'object' && item !== null && !isEmptyContainer(item)) {
      const inner = emit(item, indent + 2);
      const first = inner[0] ?? '';
      lines.push(`${pad(indent)}- ${first.trimStart()}`, ...inner.slice(1));
    } else {
      lines.push(`${pad(indent)}- ${scalar(item)}`);
    }
  }
  return lines;
}
