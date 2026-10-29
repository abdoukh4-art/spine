#!/usr/bin/env node
// TSDoc coverage of Spine's PUBLIC surface (ADR-0094), run in CI:
//  - every export of a workspace package's entry point (packages/*/src/index.ts), and
//  - every export of a module's public API (apps/api/src/modules/*/public-api.ts)
// must carry a doc comment. Internal code is not checked: a comment there is a judgement call,
// but whatever another package or module imports is a contract and must explain itself.
//
//   node scripts/check-tsdoc.mjs            # fail on any undocumented public export
//   node scripts/check-tsdoc.mjs --report   # list them all, never fail
import { readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const report = process.argv.includes('--report');

const entryPoints = [
  ...readdirSync(path.join(root, 'packages')).map((p) => `packages/${p}/src/index.ts`),
  ...readdirSync(path.join(root, 'apps/api/src/modules')).map(
    (m) => `apps/api/src/modules/${m}/public-api.ts`,
  ),
].map((f) => path.join(root, f));

const program = ts.createProgram(entryPoints, {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  allowJs: false,
  noEmit: true,
  skipLibCheck: true,
});
const checker = program.getTypeChecker();

/** True when the declaration (or, for `const x = …`, its statement) has a doc comment. */
function hasDoc(decl) {
  const nodes = [decl];
  // `export const A = …`: the JSDoc is attached to the VariableStatement, two levels up.
  if (ts.isVariableDeclaration(decl)) nodes.push(decl.parent.parent);
  return nodes.some((n) => ts.getJSDocCommentsAndTags(n).length > 0);
}

/**
 * Zod convention (ADR-0094): `export type Alert = z.infer<typeof AlertSchema>` is the schema's
 * static twin, so it inherits the schema's comment instead of repeating it.
 */
function documentedByItsSchema(name, exportsByName) {
  const schema = exportsByName.get(`${name}Schema`);
  return schema !== undefined && (schema.declarations ?? []).some(hasDoc);
}

const missing = [];
let total = 0;
for (const file of entryPoints) {
  const source = program.getSourceFile(file);
  if (!source) continue;
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) continue;
  const resolve = (e) => (e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e);
  const exportsList = checker.getExportsOfModule(moduleSymbol);
  const exportsByName = new Map(exportsList.map((e) => [e.name, resolve(e)]));
  for (const exported of exportsList) {
    const symbol = resolve(exported);
    const decls = (symbol.declarations ?? []).filter(
      (d) => !d.getSourceFile().fileName.includes('node_modules'),
    );
    if (decls.length === 0) continue; // re-exported from a third-party package
    total += 1;
    // A type and a value with the same name (Zod schema + inferred type) count as one export;
    // documenting either declaration is enough.
    if (decls.some(hasDoc) || documentedByItsSchema(exported.name, exportsByName)) continue;
    const d = decls[0];
    const { line } = d.getSourceFile().getLineAndCharacterOfPosition(d.getStart());
    missing.push(
      `${path.relative(root, d.getSourceFile().fileName)}:${line + 1}  ${exported.name}  (via ${path.relative(root, file)})`,
    );
  }
}

const unique = [...new Set(missing)].sort();
const documented = total - missing.length;
console.log(
  `tsdoc: ${documented}/${total} public exports documented (${((100 * documented) / total).toFixed(1)} %)`,
);
if (unique.length > 0) {
  console.log(unique.map((m) => `  - ${m}`).join('\n'));
  if (!report) {
    console.error(`✖ ${unique.length} undocumented public export(s); add a /** … */ comment.`);
    process.exit(1);
  }
} else {
  console.log('✔ tsdoc: every public export is documented');
}
