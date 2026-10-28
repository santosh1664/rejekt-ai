/**
 * Search everything you've applied to (the Applied screen, docs/resume-model.md).
 *
 * One phrase is matched, case-insensitively, against each field on its own:
 * company name, job title, job link (also compared on letters and digits
 * only, so "acme health" finds acme-health.wd5.myworkdayjobs.com) and posting text. Like Tsenta's submitted list,
 * each row says which fields matched and shows the posting text around a
 * match, and counts come back per field. groupBy 'company' gives one row per
 * company with how many roles you applied to there.
 */
import { query } from './db.mjs';

export const SEARCH_FIELDS = ['company', 'title', 'link', 'posting'];
const APPLIED_STATUSES = ['APPLIED', 'GHOSTED', 'INTERVIEWING', 'OFFER', 'REJECTED'];
const FIELD_SQL = {
  company: `COALESCE(j.company, a.job_snapshot->>'company', '')`,
  title: `COALESCE(j.title, a.job_snapshot->>'title', '')`,
  link: `COALESCE(a.job_snapshot->>'url', j.url, a.application_url, '')`,
  posting: `COALESCE(a.job_snapshot->>'description', '')`,
};
const escapeLike = s => s.replace(/[\\%_]/g, m => '\\' + m);

export function snippetAround(text, phrase, width = 90) {
  if (!text || !phrase) return null;
  const flat = String(text).replace(/\s+/g, ' ');
  const at = flat.toLowerCase().indexOf(phrase.toLowerCase());
  if (at < 0) return null;
  const start = Math.max(0, at - width); const end = Math.min(flat.length, at + phrase.length + width);
  return { before: (start ? '…' : '') + flat.slice(start, at), match: flat.slice(at, at + phrase.length), after: flat.slice(at + phrase.length, end) + (end < flat.length ? '…' : '') };
}

/**
 * opts: { q, fields, source: all|app|tsenta, status: applied|all, groupBy, page, limit }
 */
export async function searchApplied(userId, opts = {}) {
  const q = String(opts.q || '').trim().slice(0, 120);
  const fields = (opts.fields?.length ? opts.fields : SEARCH_FIELDS).filter(f => SEARCH_FIELDS.includes(f));
  const page = Math.max(1, +opts.page || 1); const limit = Math.min(Math.max(1, +opts.limit || 50), 200);
  const params = [userId]; const where = ['a.user_id = $1'];
  if (opts.status !== 'all') { params.push(APPLIED_STATUSES); where.push(`a.status = ANY($${params.length}::text[])`); }
  if (opts.source === 'tsenta') where.push(`a.source = 'tsenta'`);
  else if (opts.source === 'app') where.push(`a.source <> 'tsenta'`);

  let matchCols = ''; let likeParam = null;
  if (q) {
    params.push(`%${escapeLike(q)}%`); const p = `$${params.length}::text`; likeParam = p;
    // Links also match on letters and digits only: "acme health" finds acme-health.wd5.myworkdayjobs.com.
    let pBare = null;
    if (fields.includes('link')) { params.push(`%${q.toLowerCase().replace(/[^a-z0-9]+/g, '')}%`); pBare = `$${params.length}::text`; }
    const test = f => (f === 'link' ? `(${FIELD_SQL.link} ILIKE ${p} OR regexp_replace(lower(${FIELD_SQL.link}), '[^a-z0-9]+', '', 'g') LIKE ${pBare})` : `${FIELD_SQL[f]} ILIKE ${p}`);
    matchCols = SEARCH_FIELDS.map(f => `${fields.includes(f) ? test(f) : 'FALSE'} AS m_${f}`).join(', ');
    where.push(`(${fields.map(test).join(' OR ')})`);
  } else {
    matchCols = SEARCH_FIELDS.map(f => `FALSE AS m_${f}`).join(', ');
  }
  const from = `FROM applications a LEFT JOIN jobs j ON j.id = a.job_id WHERE ${where.join(' AND ')}`;

  const countsSql = `SELECT COUNT(*)::int AS total, COUNT(DISTINCT lower(${FIELD_SQL.company}))::int AS companies,
      ${SEARCH_FIELDS.map(f => `COUNT(*) FILTER (WHERE m_${f})::int AS ${f}`).join(', ')},
      COUNT(*) FILTER (WHERE source = 'tsenta')::int AS from_tsenta
    FROM (SELECT a.source, ${FIELD_SQL.company} AS company_name, ${matchCols} ${from}) x`;
  const countsQ = query(countsSql.replace(`lower(${FIELD_SQL.company})`, 'lower(company_name)'), params);

  if (opts.groupBy === 'company') {
    const pp = [...params, limit, (page - 1) * limit];
    const [{ rows }, { rows: [counts] }] = await Promise.all([query(
      `SELECT ${FIELD_SQL.company} AS company, COUNT(*)::int AS role_count, MAX(COALESCE(a.applied_at, a.created_at)) AS last_applied,
              (ARRAY_AGG(${FIELD_SQL.title} ORDER BY COALESCE(a.applied_at, a.created_at) DESC))[1:4] AS titles,
              (ARRAY_AGG(a.id ORDER BY COALESCE(a.applied_at, a.created_at) DESC))[1] AS latest_id,
              ARRAY_AGG(DISTINCT a.source) AS sources,
              COUNT(*) FILTER (WHERE a.status IN ('INTERVIEWING','OFFER'))::int AS interviews
         ${from}
        GROUP BY 1 ORDER BY last_applied DESC NULLS LAST
        LIMIT $${pp.length - 1} OFFSET $${pp.length}`, pp), countsQ]);
    const { rows: [{ n }] } = await query(`SELECT COUNT(DISTINCT ${FIELD_SQL.company})::int AS n ${from}`, params);
    return {
      q, fields, groupBy: 'company', page, limit, totalGroups: n, counts,
      companies: rows.map(r => ({ company: r.company || 'Unknown company', roleCount: r.role_count, lastAppliedAt: r.last_applied, titles: r.titles, latestApplicationId: String(r.latest_id), sources: r.sources, interviews: r.interviews })),
    };
  }

  const pp = [...params, limit, (page - 1) * limit];
  const [{ rows }, { rows: [counts] }] = await Promise.all([query(
    `SELECT a.id, a.status, a.source, a.applied_at, a.created_at, a.submitted_at,
            ${FIELD_SQL.title} AS title, ${FIELD_SQL.company} AS company, ${FIELD_SQL.link} AS url,
            COALESCE(j.location, a.job_snapshot->>'location') AS location, COALESCE(j.workplace_type, a.job_snapshot->>'workplace') AS workplace,
            a.job_snapshot->>'ats' AS ats,
            (a.job_snapshot->>'description' IS NOT NULL AND a.job_snapshot->>'description' <> '') AS has_description,
            (a.tailored_resume IS NOT NULL) AS has_resume,
            ${q && fields.includes('posting') ? `CASE WHEN ${FIELD_SQL.posting} ILIKE ${likeParam} THEN ${FIELD_SQL.posting} END` : 'NULL'} AS posting_hit,
            ${matchCols}
       ${from}
      ORDER BY COALESCE(a.applied_at, a.created_at) DESC NULLS LAST, a.id DESC
      LIMIT $${pp.length - 1} OFFSET $${pp.length}`, pp), countsQ]);
  return {
    q, fields, page, limit, total: counts.total, counts,
    pages: Math.max(1, Math.ceil(counts.total / limit)),
    applications: rows.map(r => ({
      id: String(r.id), status: r.status, source: r.source, appliedAt: r.applied_at || r.submitted_at || r.created_at,
      title: r.title, company: r.company, url: r.url, location: r.location, workplace: r.workplace, ats: r.ats,
      hasDescription: r.has_description, hasResume: r.has_resume,
      matchedOn: SEARCH_FIELDS.filter(f => r[`m_${f}`]),
      postingSnippet: r.posting_hit ? snippetAround(r.posting_hit, q) : null,
    })),
  };
}
