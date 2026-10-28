/** Deterministic skill-name normalization, backed by the taxonomy in data/skills-taxonomy.json. */
import { loadTaxonomy } from './skill-taxonomy.mjs';

export function normalizeSkillName(value = '') {
  const normalized = String(value).toLowerCase().replace(/[^a-z0-9+#./\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const { aliasToNormalizedName } = loadTaxonomy();
  return aliasToNormalizedName.get(normalized) || normalized;
}

/** True when `text` (lowercase) contains `word` as a whole word, so "erp" doesn't match "enterprise". */
export const mentions = (text, word) => new RegExp(`(^|[^a-z0-9])${String(word).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(text);
