import { readFileSync } from 'node:fs';
import path from 'node:path';

/** One attribute as described by `scripts/ocsf-contract.mjs`. */
interface AttributeContract {
  type: string;
  array?: boolean;
  requirement: 'required' | 'recommended' | 'optional';
  enum?: number[];
}

/** The generated OCSF contract for one event class (ADR-0097). */
export interface OcsfContract {
  ocsfVersion: string;
  class: { name: string; category_uid: number; class_uid: number };
  attributes: Record<string, AttributeContract>;
  objects: Record<string, { attributes: Record<string, AttributeContract> }>;
}

/** Loads a contract from `test/fixtures/ocsf/`. */
export function loadOcsfContract(file: string): OcsfContract {
  const full = path.resolve(import.meta.dirname, '../fixtures/ocsf', file);
  return JSON.parse(readFileSync(full, 'utf8')) as OcsfContract;
}

/**
 * Validates an event against an OCSF contract and returns every problem found (empty = valid):
 * missing required attributes, attributes the class doesn't define, wrong primitive types and
 * enum values outside the schema. Objects without a contract (e.g. `unmapped`) are opaque.
 */
export function validateOcsf(event: unknown, contract: OcsfContract): string[] {
  const errors: string[] = [];
  validateObject(event, contract.attributes, '', contract, errors);
  return errors;
}

function validateObject(
  value: unknown,
  attributes: Record<string, AttributeContract>,
  at: string,
  contract: OcsfContract,
  errors: string[],
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${at || '<root>'}: expected an object`);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [name, attr] of Object.entries(attributes)) {
    if (attr.requirement === 'required' && record[name] === undefined) {
      errors.push(`${at}${name}: required attribute missing`);
    }
  }
  for (const [name, v] of Object.entries(record)) {
    const attr = attributes[name];
    if (!attr) {
      errors.push(`${at}${name}: not an attribute of this OCSF object`);
      continue;
    }
    if (attr.array) {
      if (!Array.isArray(v)) errors.push(`${at}${name}: expected an array`);
      else
        v.forEach((item, i) => validateValue(item, attr, `${at}${name}[${i}]`, contract, errors));
    } else {
      validateValue(v, attr, `${at}${name}`, contract, errors);
    }
  }
}

function validateValue(
  v: unknown,
  attr: AttributeContract,
  at: string,
  contract: OcsfContract,
  errors: string[],
): void {
  if (attr.type.startsWith('object:')) {
    const objectName = attr.type.slice('object:'.length);
    const objectContract = contract.objects[objectName];
    if (!objectContract || objectName === 'object') {
      if (typeof v !== 'object' || v === null) errors.push(`${at}: expected an object`);
      return;
    }
    validateObject(v, objectContract.attributes, `${at}.`, contract, errors);
    return;
  }
  const ok = (() => {
    switch (attr.type) {
      case 'integer_t':
      case 'long_t':
      case 'timestamp_t':
        return Number.isInteger(v);
      case 'float_t':
        return typeof v === 'number';
      case 'boolean_t':
        return typeof v === 'boolean';
      case 'json_t':
        return true;
      default:
        return typeof v === 'string';
    }
  })();
  if (!ok) errors.push(`${at}: expected ${attr.type}, got ${JSON.stringify(v)}`);
  if (attr.enum && typeof v === 'number' && !attr.enum.includes(v)) {
    errors.push(`${at}: ${v} is not one of ${attr.enum.join(', ')}`);
  }
}
