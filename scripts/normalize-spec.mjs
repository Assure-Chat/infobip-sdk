#!/usr/bin/env node
/**
 * Normalize the vendor OpenAPI document before type generation.
 *
 * Infobip publishes one document for the whole platform and namespaces each
 * product's schemas with a 64-hex content hash — `899caf…708f.MessagesApiRequest`.
 * Generating straight off that gives every type a name nobody can type, and the
 * hash changes whenever the upstream document is regenerated, so the diff churns
 * even when the schema itself is unchanged.
 *
 * This script strips the prefix from schema keys and from every `$ref` that
 * points at one. It refuses to write anything if two prefixed names collapse
 * onto the same bare name, so a future spec drop that genuinely collides fails
 * loudly instead of silently dropping a schema.
 *
 * Usage: node scripts/normalize-spec.mjs <input.json> <output.json>
 */
import { readFile, writeFile } from 'node:fs/promises';

const PREFIX = /^[0-9a-f]{64}\./;
const REF_PREFIX = /^(#\/components\/schemas\/)[0-9a-f]{64}\.(.+)$/;

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('usage: node scripts/normalize-spec.mjs <input.json> <output.json>');
  process.exit(2);
}

const document = JSON.parse(await readFile(inputPath, 'utf8'));
const schemas = document.components?.schemas;
if (!schemas) {
  console.error(`${inputPath} has no components.schemas — is this an OpenAPI document?`);
  process.exit(1);
}

// Collapse the keys first so a collision is caught before anything is rewritten.
const renamed = {};
const collisions = [];
for (const [name, schema] of Object.entries(schemas)) {
  const bare = name.replace(PREFIX, '');
  if (bare in renamed) collisions.push(bare);
  renamed[bare] = schema;
}
if (collisions.length > 0) {
  console.error(
    `Refusing to normalize: ${collisions.length} schema name(s) collide once the ` +
      `hash prefix is removed — ${collisions.join(', ')}. Namespace them by hand ` +
      `before regenerating.`,
  );
  process.exit(1);
}
document.components.schemas = renamed;

const stripped = rewriteRefs(document);

await writeFile(outputPath, `${JSON.stringify(stripped, null, 2)}\n`, 'utf8');
console.log(
  `normalized ${Object.keys(schemas).length} schemas → ${outputPath} ` +
    `(${countPrefixed(schemas)} prefixes removed)`,
);

/** Rewrite every `$ref` string in place, depth-first. */
function rewriteRefs(node) {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node === null || typeof node !== 'object') return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') {
      out[key] = value.replace(REF_PREFIX, '$1$2');
      continue;
    }
    // Discriminator mappings name schemas too, in bare or `$ref` form.
    if (key === 'mapping' && value && typeof value === 'object') {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          typeof v === 'string' ? v.replace(REF_PREFIX, '$1$2').replace(PREFIX, '') : v,
        ]),
      );
      continue;
    }
    out[key] = rewriteRefs(value);
  }
  return out;
}

function countPrefixed(original) {
  return Object.keys(original).filter((name) => PREFIX.test(name)).length;
}
