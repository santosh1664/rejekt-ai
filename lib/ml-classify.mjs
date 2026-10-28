/**
 * lib/ml-classify.mjs
 *
 * Was a Node.js client for the ML classifier server (ml/classifier-server.py),
 * preferring it over the keyword classifier whenever reachable.
 *
 * role-family-v2 (upstream role-family classifier phase): DISABLED. Audit
 * evidence: `ml/train.py` trains this model exclusively on
 * `category_source='keyword'` rows — i.e. it's a distillation of
 * classifyCategory()'s OWN historical output, so it inherited every bias in
 * the old (buggy) keyword classifier by construction, plus its own
 * generalization errors on top. Quantified live: of 1,442 corpus jobs with
 * a clear non-software engineering-discipline title sitting in
 * SOFTWARE_ENGINEERING/DATA_SCIENCE/DEVOPS_SRE, 1,044 (72%) were
 * ML-sourced — e.g. "Cookie Crew" (category_source='ml',
 * predicted_value='software_engineering'), where the keyword classifier
 * itself had ALREADY correctly predicted 'other' for the very same job,
 * and the ML model overrode it. Fixing classifyCategory() alone cannot fix
 * ongoing ingestion while this frozen, bias-inheriting model keeps taking
 * precedence over it. The model is left on disk (`ml/model.joblib`) in
 * case a future phase wants to retrain it against the hardened keyword
 * classifier's output — not deleted, just no longer consulted.
 */
import { classifyCategory } from './fingerprint.mjs';

/**
 * Classify a job title+description. Always uses the keyword classifier now
 * — signature/contract unchanged so no call site (scanner/worker.mjs) needs
 * to change.
 * @param {string} title
 * @param {string} [_description] - unused; kept for call-site compatibility
 * @returns {Promise<{category: string, source: 'keyword'}>}
 */
export async function smartClassify(title, _description = '') {
  return { category: classifyCategory(title), source: 'keyword' };
}
