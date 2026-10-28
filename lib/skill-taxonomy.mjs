/**
 * Loads and compiles data/skills-taxonomy.json into matchers used by
 * lib/skill-extract.mjs (description scanning) and lib/skills.mjs
 * (free-text normalization for filters/profile match). Adding a skill is a
 * data change to the JSON file — this module needs no edits for that.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAXONOMY_PATH = join(__dirname, '..', 'data', 'skills-taxonomy.json');

let cached = null;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word/phrase-boundary match without relying on \b, which misbehaves for
// aliases that start or end in punctuation (\bc\+\+\b never matches "C++" —
// \b requires a word/non-word transition, and both sides of a trailing "+"
// are non-word). Lookaround against "is this a word character" works
// uniformly regardless of the alias's own characters.
function buildAliasRegex(alias, caseSensitive) {
  const escaped = escapeRegex(alias);
  const pattern = `(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`;
  return new RegExp(pattern, caseSensitive ? 'g' : 'gi');
}

function compileTaxonomy(raw) {
  const skills = raw.skills.map(entry => ({
    canonicalName: entry.canonicalName,
    normalizedName: entry.normalizedName,
    category: entry.category,
    baseConfidence: entry.baseConfidence ?? 0.8,
    exclude: entry.exclude || [],
  }));

  const skillByNormalizedName = new Map(skills.map(s => [s.normalizedName, s]));

  // One matcher per alias, each pointing back at its owning skill. Kept as a
  // flat list (not one giant combined regex) so per-alias caseSensitive and
  // exclude rules stay simple; description texts are small enough (a few KB)
  // that scanning ~280 patterns per job is not a meaningful cost at our scan
  // volume (single-digit ms, verified during Step 15 performance checks).
  const matchers = raw.skills.flatMap(entry =>
    entry.aliases.map(alias => ({
      regex: buildAliasRegex(alias, !!entry.caseSensitive),
      normalizedName: entry.normalizedName,
    }))
  );

  // For free-text normalization (server.mjs filters, profile-match input):
  // alias string -> canonical normalizedName, case-insensitive, matched
  // after the same lowercase/punctuation-strip normalization normalizeText()
  // applies. Ambiguous case-sensitive aliases (Go, R, C, ...) are
  // intentionally included here too — a user typing "go" into a skills
  // filter unambiguously means the Go language (there's no "Spark Capital"
  // stand-in risk in a short filter query the way there is in freeform
  // description text), so free-text lookup does not apply caseSensitive.
  // searchOnlyAliases: terms deliberately dropped from extraction because
  // they're too ambiguous in freeform description text (e.g. bare "spark"
  // overwhelmingly matches "Spark Capital"/motivational verbs, not Apache
  // Spark — see the Apache Spark entry's _note) but are unambiguous as a
  // short, deliberate filter query, where a user typing "Spark" obviously
  // means the tool. These resolve free-text lookups to real data (jobs
  // extracted via "apache spark"/"pyspark") without reintroducing the
  // extraction-time false positives.
  const aliasToNormalizedName = new Map();
  for (const entry of raw.skills) {
    for (const alias of [...entry.aliases, ...(entry.searchOnlyAliases || [])]) {
      aliasToNormalizedName.set(alias.toLowerCase(), entry.normalizedName);
    }
    aliasToNormalizedName.set(entry.normalizedName.toLowerCase(), entry.normalizedName);
  }

  return { version: raw.version, skills, skillByNormalizedName, matchers, aliasToNormalizedName };
}

export function loadTaxonomy() {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(TAXONOMY_PATH, 'utf8'));
  cached = compileTaxonomy(raw);
  return cached;
}

export function getTaxonomyVersion() {
  return loadTaxonomy().version;
}
