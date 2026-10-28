/**
 * scripts/test-keyword-search.mjs
 *
 * Tests for the feed keyword search (matching/keyword-search.mjs,
 * matching/recommend.mjs, api/server.mjs /users/:id/search).
 *
 *   node scripts/test-keyword-search.mjs
 *     Pure unit tests only — no database needed.
 *
 *   DATABASE_URL=postgres://postgres@localhost:5432/jobs_test \
 *     node scripts/test-keyword-search.mjs --db
 *     Also seeds a small fixture corpus and exercises the real API end to
 *     end. Refuses to run unless DATABASE_URL points at localhost, because
 *     it inserts and deletes rows. Run `npm run migrate` against that DB first.
 */
import {
  parseTerms, normalizeKeywordSearch, expandTitleTerm, buildKeywordSql,
  classifyKeywordMatch, rebaseScore, keywordSearchWarnings,
} from '../matching/keyword-search.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); }
}

// ── Pure unit tests ─────────────────────────────────────────────────────────
function unitTests() {
  check('parseTerms splits on |, trims, dedupes case-insensitively',
    JSON.stringify(parseTerms(' react | Frontend|react ||')) === JSON.stringify(['react', 'Frontend']), parseTerms(' react | Frontend|react ||'));
  check('parseTerms accepts arrays containing | too',
    JSON.stringify(parseTerms(['a|b', 'c'])) === JSON.stringify(['a', 'b', 'c']));
  check('parseTerms caps term count at 20', parseTerms(Array.from({ length: 40 }, (_, i) => `t${i}`)).length === 20);

  const bad = normalizeKeywordSearch({ include: 'x', scope: 'everywhere' });
  check('invalid scope is rejected with an error', bad.errors.length === 1 && bad.scope === 'title');
  const empty = normalizeKeywordSearch({ include: '', exclude: [] });
  check('empty search is inactive', empty.active === false);
  check('scope defaults to title', normalizeKeywordSearch({ include: 'react' }).scope === 'title');

  const roles = term => expandTitleTerm(term).map(r => r.canonicalRole);
  check('"GenAI engineer" expands to AI_ENGINEER + ML_ENGINEER (semantic title match)',
    roles('GenAI engineer').includes('AI_ENGINEER') && roles('GenAI engineer').includes('ML_ENGINEER'), roles('GenAI engineer'));
  check('"ML engineer" expands to ML_ENGINEER + AI_ENGINEER', roles('ML engineer').includes('AI_ENGINEER'), roles('ML engineer'));
  check('"Java developer" maps to BACKEND_ENGINEER', roles('Java developer')[0] === 'BACKEND_ENGINEER', roles('Java developer'));
  check('"react" maps to FRONTEND_ENGINEER', roles('react')[0] === 'FRONTEND_ENGINEER', roles('react'));
  check('"SDET" expands to QA_AUTOMATION_ENGINEER (very close)', roles('SDET').includes('QA_AUTOMATION_ENGINEER'), roles('SDET'));
  check('generic "software engineer" does not expand (literal match only)', roles('software engineer').length === 0, roles('software engineer'));
  check('backend does not pull in CLOSE-only roles like FULL_STACK', !roles('backend engineer').includes('FULL_STACK_ENGINEER'), roles('backend engineer'));
  check('nonsense term expands to nothing', roles('underwater basket weaving').length === 0, roles('underwater basket weaving'));

  {
    const params = [];
    const { conditions, semanticRoles } = buildKeywordSql(normalizeKeywordSearch({ include: 'GenAI engineer|react' }), params);
    check('title scope builds one include condition', conditions.length === 1);
    check('title scope uses normalized_title + title + canonical_role', /normalized_title LIKE ANY/.test(conditions[0]) && /title ILIKE ANY/.test(conditions[0]) && /canonical_role = ANY/.test(conditions[0]), conditions[0]);
    check('title scope never touches description', !/search_vector/.test(conditions[0]));
    check('semantic roles recorded for scoring', semanticRoles.has('AI_ENGINEER') && semanticRoles.has('FRONTEND_ENGINEER'));
    check('LIKE wildcards in terms are escaped', (() => { const p = []; buildKeywordSql(normalizeKeywordSearch({ include: '100%_remote' }), p); return p[1][0] === '%100\\%\\_remote%'; })());
  }
  {
    const params = [];
    const { conditions } = buildKeywordSql(normalizeKeywordSearch({ include: 'LangChain', scope: 'title_description' }), params);
    check('title_description adds full-text + skills', /search_vector @@/.test(conditions[0]) && /job_skills/.test(conditions[0]), conditions[0]);
  }
  {
    const params = [];
    const { conditions } = buildKeywordSql(normalizeKeywordSearch({ include: 'LangChain', scope: 'description' }), params);
    check('description scope restricts to description weight', /ts_filter\(j\.search_vector, '\{c\}'\)/.test(conditions[0]) && !/ILIKE/.test(conditions[0]), conditions[0]);
  }
  {
    const params = [];
    const { conditions } = buildKeywordSql(normalizeKeywordSearch({ exclude: 'senior|staff' }), params);
    check('title-scope exclude is NOT(literal title) only', conditions.length === 1 && /^NOT \(/.test(conditions[0]) && !/canonical_role|search_vector/.test(conditions[0]), conditions[0]);
  }
  check('description-scope exclude produces an over-hiding warning',
    keywordSearchWarnings(normalizeKeywordSearch({ exclude: 'senior', scope: 'title_description' })).length === 1);

  {
    const ks = normalizeKeywordSearch({ include: 'GenAI engineer|software engineer' });
    const { semanticRoles } = buildKeywordSql(ks, []);
    const m1 = classifyKeywordMatch({ title: 'Sr. Software Engineer, Payments', canonicalRole: 'SOFTWARE_ENGINEER' }, ks, semanticRoles);
    check('literal title hit (through Sr. normalization) is TITLE/1.0', m1.type === 'TITLE' && m1.strength === 1, m1);
    const m2 = classifyKeywordMatch({ title: 'Machine Learning Engineer II', canonicalRole: 'ML_ENGINEER' }, ks, semanticRoles);
    check('canonical-role hit is SEMANTIC_TITLE with weaker strength', m2.type === 'SEMANTIC_TITLE' && m2.strength < 1 && m2.term === 'GenAI engineer', m2);
  }
  {
    const base = { matchScore: 58, rawScore: 70, components: { experience: 90 } };
    const boosted = rebaseScore(base, { type: 'TITLE', strength: 1 });
    check('title match lifts the role cap and boosts the score', boosted > 70 && boosted <= 100, boosted);
    const capped = rebaseScore({ matchScore: 55, rawScore: 72, components: { experience: 10 } }, { type: 'TITLE', strength: 1 });
    check('experience cap still holds under a title match', capped <= 55, capped);
    const desc = rebaseScore({ matchScore: 58, rawScore: 70, components: { experience: 90 } }, { type: 'DESCRIPTION', strength: 0.4 });
    check('description-only match keeps the role cap as its base', desc >= 58 && desc < 70, desc);
    check('rebase never lowers a score', rebaseScore({ matchScore: 90, rawScore: 90, components: { experience: 30 } }, { type: 'TITLE', strength: 1 }) >= 75);
  }
}

// ── End-to-end against a disposable local database ─────────────────────────
async function dbTests() {
  const url = process.env.DATABASE_URL || '';
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
    console.log('SKIP  --db tests: DATABASE_URL must point at localhost (this test inserts/deletes rows).');
    failures++;
    return;
  }
  const { query, closePool } = await import('../lib/db.mjs');
  const { spawn } = await import('node:child_process');
  const USER = '00000000-0000-4000-8000-00000000c0de';
  const PORT = 3999;
  const MARK = 'kwtest';

  // Fixture corpus: a Java/Spring backend profile, plus jobs across families.
  const jobs = [
    ['Backend Engineer (Java)', 'SOFTWARE_ENGINEERING', 'BACKEND_ENGINEER', 'Build Spring Boot services.', ['java', 'spring boot']],
    ['Senior Backend Engineer', 'SOFTWARE_ENGINEERING', 'BACKEND_ENGINEER', 'Senior role, Java.', ['java']],
    ['Software Engineer II', 'SOFTWARE_ENGINEERING', 'SOFTWARE_ENGINEER', 'General engineering.', ['java']],
    ['Frontend Engineer, React', 'SOFTWARE_ENGINEERING', 'FRONTEND_ENGINEER', 'React and TypeScript UI work.', ['react']],
    ['Machine Learning Engineer', 'DATA_SCIENCE', 'ML_ENGINEER', 'Train models with PyTorch.', ['python']],
    ['AI Engineer, Agents', 'DATA_SCIENCE', 'AI_ENGINEER', 'Build agents using LangChain and RAG.', ['python', 'langchain']],
    ['Platform Engineer', 'DEVOPS_SRE', 'PLATFORM_ENGINEER', 'Kubernetes platform. Experience with LangChain a plus.', ['kubernetes']],
    ['Account Executive', 'SALES', 'SALES', 'Sell software.', []],
  ];
  const cleanup = async () => {
    await query(`DELETE FROM jobs WHERE ats = $1`, [MARK]);
    await query(`DELETE FROM user_keyword_searches WHERE user_id = $1`, [USER]);
    await query(`DELETE FROM user_job_interactions WHERE user_id = $1`, [USER]);
    await query(`DELETE FROM user_profiles WHERE user_id = $1`, [USER]); // cascades target roles/skills/prefs
  };
  await cleanup();
  const ids = {};
  for (const [i, [title, family, role, desc, skills]] of jobs.entries()) {
    const { rows } = await query(
      `INSERT INTO jobs (url, title, normalized_title, company, ats, role_family, canonical_role, description_clean,
                         workplace_type, employment_type, status, active, fingerprint, discovered, posted_at, sponsorship_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'REMOTE','FULL_TIME','READY',TRUE,$9,NOW() - ($10 * interval '1 hour'), NOW(), 'NOT_MENTIONED')
       RETURNING id`,
      [`https://example.test/${i}`, title, title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
        `Co${i}`, MARK, family, role, desc, `kw${String(i).padStart(14, '0')}`, i]
    );
    ids[title] = String(rows[0].id);
    for (const s of skills) {
      const { rows: sr } = await query(
        `INSERT INTO skills (canonical_name, normalized_name) VALUES ($1,$1)
         ON CONFLICT (normalized_name) DO UPDATE SET canonical_name = skills.canonical_name RETURNING id`, [s]);
      await query(`INSERT INTO job_skills (job_id, skill_id, importance) VALUES ($1,$2,'REQUIRED') ON CONFLICT DO NOTHING`, [rows[0].id, sr[0].id]);
    }
  }

  const server = spawn(process.execPath, ['api/server.mjs', '--port', String(PORT)], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let serverLog = '';
  server.stderr.on('data', d => { serverLog += d; });
  const base = `http://localhost:${PORT}`;
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/health`); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const titles = r => r.body.jobs.map(j => j.title);

  try {
    let r = await call('GET', `/users/${USER}/recommendations?search=react`);
    check('no profile → NO_PROFILE', r.body.zeroResultReason === 'NO_PROFILE', r.body);

    await call('PUT', `/users/${USER}/profile`, { current_title: 'Backend Engineer', total_experience_years: 3, current_country: 'US', needs_sponsorship: false });
    await call('PUT', `/users/${USER}/target-roles`, { roles: [{ canonicalRole: 'BACKEND_ENGINEER', roleFamily: 'SOFTWARE_ENGINEERING' }] });
    await call('PUT', `/users/${USER}/skills`, { skills: [{ name: 'Java' }, { name: 'Spring Boot' }] });

    r = await call('GET', `/users/${USER}/recommendations?limit=50`);
    check('baseline feed is narrowed to profile-adjacent families (no sales job)',
      !titles(r).includes('Account Executive') && titles(r).length > 0, titles(r));
    r = await call('GET', `/users/${USER}/recommendations?search=account%20executive&limit=50`);
    check('a title search reaches outside those families', JSON.stringify(titles(r)) === JSON.stringify(['Account Executive']), titles(r));

    r = await call('GET', `/users/${USER}/recommendations?search=react&limit=50`);
    check('title search "react" finds the React job despite a Java profile', titles(r).includes('Frontend Engineer, React'), titles(r));
    check('…and only jobs matching react', titles(r).every(t => /react/i.test(t)), titles(r));
    check('…with a rebased score and explanation', r.body.jobs[0]?.scoreRebased === true && /Title matches/.test(r.body.jobs[0]?.whyMatched[0]), r.body.jobs[0]);

    r = await call('GET', `/users/${USER}/recommendations?search=GenAI%20engineer&limit=50`);
    check('semantic title search "GenAI engineer" finds AI + ML engineer jobs (searches every family)',
      titles(r).includes('AI Engineer, Agents') && titles(r).includes('Machine Learning Engineer'), titles(r));
    check('…via SEMANTIC_TITLE, not a literal hit', r.body.jobs.every(j => j.keywordMatch.type === 'SEMANTIC_TITLE'), r.body.jobs.map(j => j.keywordMatch));

    r = await call('GET', `/users/${USER}/recommendations?search=LangChain&limit=50`);
    check('title scope "LangChain" matches nothing (it lives in descriptions)', r.body.total === 0 && r.body.zeroResultReason === 'NO_MATCHING_JOBS', r.body);
    r = await call('GET', `/users/${USER}/recommendations?search=LangChain&search_scope=title_description&limit=50`);
    check('title_description "LangChain" finds jobs via description/skills',
      titles(r).includes('AI Engineer, Agents') && titles(r).includes('Platform Engineer'), titles(r));
    check('…flagged as DESCRIPTION matches', r.body.jobs.every(j => j.keywordMatch.type === 'DESCRIPTION'));

    r = await call('GET', `/users/${USER}/recommendations?search=backend&exclude_search=senior&limit=50`);
    check('exclude hides "Senior Backend Engineer", keeps the other backend job',
      titles(r).includes('Backend Engineer (Java)') && !titles(r).includes('Senior Backend Engineer'), titles(r));

    r = await call('GET', `/users/${USER}/recommendations?search=react&search_scope=bogus`);
    check('bad scope → 400', r.status === 400, r);

    await call('PUT', `/users/${USER}/profile/preferences`, { remote_only: true });
    await query(`UPDATE jobs SET workplace_type = 'ONSITE' WHERE ats = $1 AND title = 'Frontend Engineer, React'`, [MARK]);
    r = await call('GET', `/users/${USER}/recommendations?search=react`);
    check('keyword matches but filters remove it → FILTERS_NARROW with activeFilters',
      r.body.zeroResultReason === 'FILTERS_NARROW' && r.body.activeFilters.includes('remoteOnly'), r.body);

    r = await call('PUT', `/users/${USER}/search`, { include: ['react'] });
    check('saving a keyword that empties the feed is refused (422)', r.status === 422 && r.body.refused === true, r);
    r = await call('PUT', `/users/${USER}/search`, { include: ['underwater basket weaving'] });
    check('…and a keyword that matches nothing says NO_MATCHING_JOBS', r.status === 422 && r.body.zeroResultReason === 'NO_MATCHING_JOBS', r.body);

    r = await call('PUT', `/users/${USER}/search`, { include: 'backend|software engineer', exclude: ['senior'] });
    check('a working keyword saves with a preview', r.status === 200 && r.body.saved === true && r.body.preview.total >= 2, r.body);
    r = await call('GET', `/users/${USER}/recommendations?limit=50`);
    check('saved keyword applies to the feed by default', r.body.keywordSearch?.source === 'saved' && !titles(r).includes('Senior Backend Engineer') && !titles(r).includes('Platform Engineer'), titles(r));
    r = await call('GET', `/users/${USER}/recommendations?limit=50&use_saved_search=false`);
    check('use_saved_search=false bypasses it', r.body.keywordSearch === null && titles(r).includes('Senior Backend Engineer'), titles(r));
    r = await call('GET', `/users/${USER}/recommendations?limit=50&search=react`);
    check('request params preview without touching the saved search', r.body.keywordSearch?.source === 'request');
    r = await call('GET', `/users/${USER}/search`);
    check('GET /search returns the saved terms', JSON.stringify(r.body.include) === JSON.stringify(['backend', 'software engineer']), r.body);

    await query(`INSERT INTO user_job_interactions (user_id, job_id, interaction_type) VALUES ($1, $2, 'APPLY')`, [USER, ids['Backend Engineer (Java)']]);
    r = await call('GET', `/users/${USER}/recommendations?limit=50`);
    check('applied jobs drop out of a keyword feed too', !titles(r).includes('Backend Engineer (Java)'), titles(r));

    r = await call('DELETE', `/users/${USER}/search`);
    check('DELETE clears the saved search', r.body.cleared === true);
    r = await call('GET', `/users/${USER}/search`);
    check('…and GET reports it inactive', r.body.active === false);
  } finally {
    server.kill();
    await cleanup();
    await closePool();
    if (failures) console.log(serverLog.slice(-2000));
  }
}

unitTests();
if (process.argv.includes('--db')) await dbTests();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;
