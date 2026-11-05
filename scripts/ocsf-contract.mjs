#!/usr/bin/env node
// Extracts a small, offline "contract" for one OCSF event class from a checkout of the official
// schema (https://github.com/ocsf/ocsf-schema), so Spine's OCSF export can be validated in CI
// without network access (ADR-0097).
//
//   git clone --depth 1 --branch 1.9.0 https://github.com/ocsf/ocsf-schema /tmp/ocsf-schema
//   node scripts/ocsf-contract.mjs /tmp/ocsf-schema detection_finding \
//     > apps/api/test/fixtures/ocsf/detection_finding-1.9.0.contract.json
//
// The contract lists, for the class and every object it uses: each attribute's type, whether it
// is an array, its requirement and its enum values (merged with the dictionary's, as OCSF does).
// Inheritance (`extends`) is resolved. Only what a validator needs; not a full OCSF compiler.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const [root, className] = process.argv.slice(2);
if (!root || !className) {
  console.error('usage: ocsf-contract.mjs <ocsf-schema-dir> <class-name>');
  process.exit(2);
}
const read = (...p) => JSON.parse(readFileSync(path.join(root, ...p), 'utf8'));
const dictionary = read('dictionary.json');
const dictAttrs = dictionary.attributes;
const dictTypes = dictionary.types.attributes;
const categories = read('categories.json').attributes;

function findFile(dir, name) {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const found = findFile(path.join(dir, entry.name), name);
      if (found) return found;
    } else if (entry.name === `${name}.json`) return path.join(dir, entry.name);
  }
  return null;
}

/** Loads a class or object definition with its `extends` chain merged (child wins). */
function load(kind, name) {
  const file = findFile(kind, name);
  if (!file) throw new Error(`${kind}/${name}.json not found`);
  const def = read(file);
  const parent = def.extends && def.extends !== name ? load(kind, def.extends) : { attributes: {} };
  const attributes = { ...parent.attributes };
  for (const [k, v] of Object.entries(def.attributes ?? {})) {
    if (k.startsWith('$')) continue;
    attributes[k] = { ...(attributes[k] ?? {}), ...v };
  }
  return { ...parent, ...def, attributes };
}

/** The primitive OCSF type an attribute ultimately has (`hostname_t` → string_t, …). */
function baseType(type) {
  let t = type;
  for (let i = 0; i < 5 && dictTypes[t]?.type; i += 1) t = dictTypes[t].type;
  return t;
}

const objectsNeeded = new Set();
function describe(attributes) {
  const out = {};
  for (const [name, local] of Object.entries(attributes)) {
    const dict = dictAttrs[name] ?? {};
    const type = local.type ?? dict.type;
    const enumValues = { ...(dict.enum ?? {}), ...(local.enum ?? {}) };
    // In the dictionary an object-valued attribute's `type` is the object's name (`finding_info`);
    // primitive types end in `_t`. `object` itself is the untyped object (e.g. `unmapped`).
    const objectType =
      local.object_type ?? dict.object_type ?? (type && !type.endsWith('_t') ? type : undefined);
    const isObject = objectType !== undefined;
    if (objectType) objectsNeeded.add(objectType);
    out[name] = {
      type: isObject ? `object:${objectType}` : baseType(type ?? 'string_t'),
      ...((local.is_array ?? dict.is_array) ? { array: true } : {}),
      requirement: local.requirement ?? 'optional',
      ...(Object.keys(enumValues).length > 0 && !isObject
        ? {
            enum: Object.keys(enumValues)
              .map(Number)
              .sort((a, b) => a - b),
          }
        : {}),
    };
  }
  return out;
}

const cls = load('events', className);
const categoryUid = categories[cls.category]?.uid;
const contract = {
  ocsfVersion: read('version.json').version,
  source: {
    repository: 'https://github.com/ocsf/ocsf-schema',
    commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  },
  class: {
    name: className,
    caption: cls.caption,
    category_uid: categoryUid,
    class_uid: categoryUid * 1000 + cls.uid,
  },
  attributes: describe(cls.attributes),
  objects: {},
};
// Objects referenced by the class, three levels deep (class → finding_info → attack → tactic) covers
// everything Spine emits. The validator treats objects it has no contract for as opaque.
let frontier = [...objectsNeeded];
for (let depth = 0; depth < 3; depth += 1) {
  objectsNeeded.clear();
  for (const name of frontier) {
    if (contract.objects[name]) continue;
    try {
      contract.objects[name] = { attributes: describe(load('objects', name).attributes) };
    } catch {
      // Abstract or unknown objects (e.g. `object`) stay opaque.
    }
  }
  frontier = [...objectsNeeded].filter((n) => !contract.objects[n]);
}

// Like the OCSF compiler, pin the class identity: base_event's placeholders (`0 Uncategorized`,
// `0 Base Event`) become this class's uids, and `type_uid` = class_uid × 100 + activity_id.
const { category_uid: catUid, class_uid: clsUid } = contract.class;
contract.attributes.category_uid.enum = [catUid];
contract.attributes.class_uid.enum = [clsUid];
contract.attributes.type_uid.enum = (contract.attributes.activity_id.enum ?? []).map(
  (activity) => clsUid * 100 + activity,
);

// `observable.type_id` is assembled by OCSF from every type and attribute marked `observable`
// (1 Hostname, 2 IP Address, 8 Hash, ...), as the schema server does.
const observableIds = new Set([0, 99]);
for (const def of [...Object.values(dictTypes), ...Object.values(dictAttrs)]) {
  if (typeof def?.observable === 'number') observableIds.add(def.observable);
}
const observableTypeId = contract.objects.observable?.attributes.type_id;
if (observableTypeId) observableTypeId.enum = [...observableIds].sort((a, b) => a - b);
process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
