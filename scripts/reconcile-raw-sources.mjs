import { query, closePool } from '../lib/db.mjs';

const BATCH = 250;

async function main() {
  let lastId = 0;
  let processed = 0;
  while (true) {
    const { rows } = await query(
      `SELECT id, url, ats, company, title, location, description, posted_at, raw
         FROM jobs
        WHERE id > $1 AND raw_job_id IS NULL
        ORDER BY id LIMIT $2`, [lastId, BATCH]
    );
    if (rows.length === 0) break;

    for (const job of rows) {
      const rawResult = await query(
        `INSERT INTO raw_job_postings
           (source, url, company_raw, title_raw, location_raw, description_raw,
            posted_at_raw, payload, processing_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PROCESSED')
         ON CONFLICT (source, url) DO UPDATE SET
           last_seen_at = NOW(), payload = EXCLUDED.payload
         RETURNING id`,
        [job.ats, job.url, job.company, job.title, job.location, job.description || '',
          job.posted_at?.toISOString?.() || job.posted_at || null, JSON.stringify(job.raw || {})]
      );
      const rawJobId = rawResult.rows[0].id;
      await query('UPDATE jobs SET raw_job_id = $1 WHERE id = $2 AND raw_job_id IS NULL', [rawJobId, job.id]);
      await query(
        `INSERT INTO job_sources (job_id, raw_job_id, source, url, ats_type, is_primary)
         VALUES ($1,$2,$3,$4,$3,TRUE)
         ON CONFLICT (source, url) DO UPDATE SET job_id = EXCLUDED.job_id, raw_job_id = EXCLUDED.raw_job_id, last_seen_at = NOW()`,
        [job.id, rawJobId, job.ats, job.url]
      );
      processed++;
    }
    lastId = rows[rows.length - 1].id;
    if (processed % 2500 === 0) console.error(`Reconciled ${processed.toLocaleString()} jobs`);
  }
  console.error(`Raw/source reconciliation complete: ${processed.toLocaleString()} jobs`);
}

main().catch(error => { console.error('Reconciliation failed:', error.message); process.exitCode = 1; }).finally(() => closePool());
