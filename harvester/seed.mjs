/**
 * harvester/seed.mjs
 *
 * Seeds the companies table with known tech companies and their ATS slugs.
 * Run this BEFORE --scan if you haven't done a Common Crawl harvest yet.
 *
 * Some ATSs need per-tenant config in `meta`: Workday wants
 * { tenant, shard, site } (read from the board URL
 * https://{tenant}.{shard}.myworkdayjobs.com/{site}); this seeder now stores
 * it. Re-running fills meta in for a row that was added without it, and never
 * overwrites meta that already has values. After seeding a new ATS, confirm
 * the boards respond with:  node scanner.mjs --smoke --ats workday
 *
 * Usage:
 *   node --env-file=.env.local harvester/seed.mjs [--dry-run] [--ats greenhouse]
 */

import { query } from '../lib/db.mjs';

const SEED_COMPANIES = [
  // Greenhouse
  { name: 'Stripe',           ats: 'greenhouse', slug: 'stripe' },
  { name: 'Airbnb',           ats: 'greenhouse', slug: 'airbnb' },
  { name: 'Dropbox',          ats: 'greenhouse', slug: 'dropbox' },
  { name: 'Reddit',           ats: 'greenhouse', slug: 'reddit' },
  { name: 'Robinhood',        ats: 'greenhouse', slug: 'robinhood' },
  { name: 'DoorDash',         ats: 'greenhouse', slug: 'doordash' },
  { name: 'Figma',            ats: 'greenhouse', slug: 'figma' },
  { name: 'Notion',           ats: 'greenhouse', slug: 'notion' },
  { name: 'Plaid',            ats: 'greenhouse', slug: 'plaid' },
  { name: 'Databricks',       ats: 'greenhouse', slug: 'databricks' },
  { name: 'Snowflake',        ats: 'greenhouse', slug: 'snowflake' },
  { name: 'Confluent',        ats: 'greenhouse', slug: 'confluent' },
  { name: 'MongoDB',          ats: 'greenhouse', slug: 'mongodb' },
  { name: 'Twilio',           ats: 'greenhouse', slug: 'twilio' },
  { name: 'PagerDuty',        ats: 'greenhouse', slug: 'pagerduty' },
  { name: 'Brex',             ats: 'greenhouse', slug: 'brex' },
  { name: 'Gusto',            ats: 'greenhouse', slug: 'gusto' },
  { name: 'Lyft',             ats: 'greenhouse', slug: 'lyft' },
  { name: 'Airtable',         ats: 'greenhouse', slug: 'airtable' },
  { name: 'Asana',            ats: 'greenhouse', slug: 'asana' },
  { name: 'Intercom',         ats: 'greenhouse', slug: 'intercom' },
  { name: 'LaunchDarkly',     ats: 'greenhouse', slug: 'launchdarkly' },
  { name: 'Amplitude',        ats: 'greenhouse', slug: 'amplitude' },
  { name: 'Retool',           ats: 'greenhouse', slug: 'retool' },
  { name: 'Scale AI',         ats: 'greenhouse', slug: 'scaleai' },
  { name: 'Cohere',           ats: 'greenhouse', slug: 'cohere' },
  { name: 'Weights & Biases', ats: 'greenhouse', slug: 'weightsandbiases' },
  { name: 'Hugging Face',     ats: 'greenhouse', slug: 'huggingface' },
  { name: 'Samsara',          ats: 'greenhouse', slug: 'samsara' },
  { name: 'Toast',            ats: 'greenhouse', slug: 'toast' },
  { name: 'Rippling',         ats: 'greenhouse', slug: 'rippling' },
  { name: 'Vanta',            ats: 'greenhouse', slug: 'vanta' },
  { name: 'Lattice',          ats: 'greenhouse', slug: 'lattice' },
  { name: 'Vercel',           ats: 'greenhouse', slug: 'vercel' },
  { name: 'Grafana Labs',     ats: 'greenhouse', slug: 'grafanalabs' },
  { name: 'Hashicorp',        ats: 'greenhouse', slug: 'hashicorp' },
  { name: 'Miro',             ats: 'greenhouse', slug: 'miro' },
  { name: 'Canva',            ats: 'greenhouse', slug: 'canva' },
  { name: 'Webflow',          ats: 'greenhouse', slug: 'webflow' },
  { name: 'Checkr',           ats: 'greenhouse', slug: 'checkr' },
  { name: 'Navan',            ats: 'greenhouse', slug: 'navan' },
  { name: 'Flexport',         ats: 'greenhouse', slug: 'flexport' },
  // Lever
  { name: 'Netflix',          ats: 'lever', slug: 'netflix' },
  { name: 'Shopify',          ats: 'lever', slug: 'shopify' },
  { name: 'GitHub',           ats: 'lever', slug: 'github' },
  { name: 'Atlassian',        ats: 'lever', slug: 'atlassian' },
  { name: 'Coinbase',         ats: 'lever', slug: 'coinbase' },
  { name: 'OpenAI',           ats: 'lever', slug: 'openai' },
  { name: 'Anthropic',        ats: 'lever', slug: 'anthropic' },
  { name: 'Anduril',          ats: 'lever', slug: 'anduril' },
  { name: 'Ramp',             ats: 'lever', slug: 'ramp' },
  { name: 'Mercury',          ats: 'lever', slug: 'mercury' },
  { name: 'Deel',             ats: 'lever', slug: 'deel' },
  { name: 'Replit',           ats: 'lever', slug: 'replit' },
  { name: 'Mixpanel',         ats: 'lever', slug: 'mixpanel' },
  { name: 'Cloudflare',       ats: 'lever', slug: 'cloudflare' },
  { name: 'Snyk',             ats: 'lever', slug: 'snyk' },
  { name: 'CrowdStrike',      ats: 'lever', slug: 'crowdstrike' },
  { name: 'Okta',             ats: 'lever', slug: 'okta' },
  { name: 'Gong',             ats: 'lever', slug: 'gong-io' },
  { name: 'Outreach',         ats: 'lever', slug: 'outreach' },
  { name: 'Clari',            ats: 'lever', slug: 'clari' },
  { name: 'Waymo',            ats: 'lever', slug: 'waymo' },
  { name: 'Rivian',           ats: 'lever', slug: 'rivian' },
  { name: 'Palantir',         ats: 'lever', slug: 'palantir' },
  { name: 'Netlify',          ats: 'lever', slug: 'netlify' },
  { name: 'CircleCI',         ats: 'lever', slug: 'circleci' },
  // Ashby
  { name: 'Cursor',           ats: 'ashby', slug: 'cursor' },
  { name: 'Perplexity',       ats: 'ashby', slug: 'perplexity-ai' },
  { name: 'Mistral AI',       ats: 'ashby', slug: 'mistral' },
  { name: 'Together AI',      ats: 'ashby', slug: 'together-ai' },
  { name: 'Modal',            ats: 'ashby', slug: 'modal-labs' },
  { name: 'Baseten',          ats: 'ashby', slug: 'baseten' },
  { name: 'LangChain',        ats: 'ashby', slug: 'langchain' },
  { name: 'Resend',           ats: 'ashby', slug: 'resend' },
  { name: 'Neon',             ats: 'ashby', slug: 'neon-inc' },
  { name: 'Posthog',          ats: 'ashby', slug: 'posthog' },
  { name: 'ClickHouse',       ats: 'ashby', slug: 'clickhouse' },
  { name: 'Codeium',          ats: 'ashby', slug: 'codeium' },
  { name: 'Sourcegraph',      ats: 'ashby', slug: 'sourcegraph' },
  { name: 'Zed',              ats: 'ashby', slug: 'zed-industries' },
  { name: 'Mintlify',         ats: 'ashby', slug: 'mintlify' },
  // Workable (slug = the apply.workable.com/{slug} account).
  // Candidates — confirm live with: node scanner.mjs --smoke --ats workable
  { name: 'Typeform',         ats: 'workable', slug: 'typeform' },
  { name: 'Hotjar',           ats: 'workable', slug: 'hotjar' },
  { name: 'Workable',         ats: 'workable', slug: 'workable' },
  { name: 'Personio',         ats: 'workable', slug: 'personio' },
  { name: 'Remote',           ats: 'workable', slug: 'remote' },
  { name: 'Pipedrive',        ats: 'workable', slug: 'pipedrive' },
  { name: 'Bolt',             ats: 'workable', slug: 'bolt' },
  { name: 'Veeam',            ats: 'workable', slug: 'veeam' },
  { name: 'Quantive',         ats: 'workable', slug: 'quantive' },
  { name: 'Payhawk',          ats: 'workable', slug: 'payhawk' },
  { name: 'SiteMinder',       ats: 'workable', slug: 'siteminder' },
  { name: 'Ebury',            ats: 'workable', slug: 'ebury' },
  { name: 'Softswiss',        ats: 'workable', slug: 'softswiss' },
  { name: 'Paysafe',          ats: 'workable', slug: 'paysafe' },

  // Workday (per-tenant — meta needs { tenant, shard, site }, read from the
  // board URL https://{tenant}.{shard}.myworkdayjobs.com/{site}). Candidates —
  // confirm live with: node scanner.mjs --smoke --ats workday
  { name: 'NVIDIA',           ats: 'workday', slug: 'nvidia/NVIDIAExternalCareerSite',
    meta: { tenant: 'nvidia', shard: 'wd5', site: 'NVIDIAExternalCareerSite' } },
  { name: 'Salesforce',       ats: 'workday', slug: 'salesforce/External_Career_Site',
    meta: { tenant: 'salesforce', shard: 'wd12', site: 'External_Career_Site' } },
  { name: 'Workday',          ats: 'workday', slug: 'workday/Workday',
    meta: { tenant: 'workday', shard: 'wd5', site: 'Workday' } },
  { name: 'Dell',             ats: 'workday', slug: 'dell/External',
    meta: { tenant: 'dell', shard: 'wd1', site: 'External' } },
  { name: 'Mastercard',       ats: 'workday', slug: 'mastercard/CorporateCareers',
    meta: { tenant: 'mastercard', shard: 'wd1', site: 'CorporateCareers' } },
  { name: 'Capital One',      ats: 'workday', slug: 'capitalone/Capital_One',
    meta: { tenant: 'capitalone', shard: 'wd1', site: 'Capital_One' } },
  { name: 'Thomson Reuters',  ats: 'workday', slug: 'thomsonreuters/External',
    meta: { tenant: 'thomsonreuters', shard: 'wd3', site: 'External' } },
  { name: 'SAP',              ats: 'workday', slug: 'sap/SAPCareers',
    meta: { tenant: 'sap', shard: 'wd3', site: 'SAPCareers' } },
  // SmartRecruiters
  { name: 'Visa',             ats: 'smartrecruiters', slug: 'visa' },
  { name: 'Bosch',            ats: 'smartrecruiters', slug: 'bosch' },
  { name: 'HelloFresh',       ats: 'smartrecruiters', slug: 'hellofresh' },
  { name: 'Klarna',           ats: 'smartrecruiters', slug: 'klarna' },
  { name: 'Zalando',          ats: 'smartrecruiters', slug: 'zalando' },
  { name: 'Celonis',          ats: 'smartrecruiters', slug: 'celonis' },
  { name: 'Doctolib',         ats: 'smartrecruiters', slug: 'doctolib' },
  // BambooHR
  { name: 'Podium',           ats: 'bamboohr', slug: 'podium' },
  { name: 'Qualtrics',        ats: 'bamboohr', slug: 'qualtrics' },
  { name: 'Domo',             ats: 'bamboohr', slug: 'domo' },
  { name: 'Lucid',            ats: 'bamboohr', slug: 'lucid' },
  { name: 'Pluralsight',      ats: 'bamboohr', slug: 'pluralsight' },
];

const args    = process.argv.slice(2);
const dryRun  = args.includes('--dry-run');
const atsOnly = args[args.indexOf('--ats') + 1];
const verbose = args.includes('--verbose');

const unique = [];
const seen   = new Set();
for (const c of SEED_COMPANIES) {
  const key = `${c.ats}::${c.slug}`;
  if (!seen.has(key)) { seen.add(key); unique.push(c); }
}

const toSeed = atsOnly ? unique.filter(c => c.ats === atsOnly) : unique;

console.error(`\n🌱  Seeding ${toSeed.length} known companies${atsOnly ? ` (${atsOnly} only)` : ''}${dryRun ? '  [DRY RUN]' : ''}\n`);

if (!dryRun) {
  let inserted = 0, existing = 0;
  for (const c of toSeed) {
    try {
      // meta carries per-tenant config some ATSs require: tenant/shard/site
      // (Workday), host/site (Oracle), domain (BambooHR). On re-seed we fill
      // meta in for a row that was added without it, but never overwrite one
      // that already has values.
      const { rows } = await query(
        `INSERT INTO companies (name, ats, slug, meta, discovered)
              VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (ats, slug) DO UPDATE
            SET meta = CASE WHEN companies.meta = '{}'::jsonb OR companies.meta IS NULL
                            THEN EXCLUDED.meta ELSE companies.meta END
         RETURNING (xmax = 0) AS inserted`,
        [c.name, c.ats, c.slug, JSON.stringify(c.meta || {})]
      );
      if (rows[0]?.inserted) { inserted++; if (verbose) console.error(`  ✓ [${c.ats}] ${c.name}`); }
      else existing++;
    } catch (err) {
      console.error(`  ✗ ${c.ats}/${c.slug}: ${err.message}`);
    }
  }
  console.error(`\n✅  Seed complete — inserted: ${inserted}  already existed: ${existing}\n`);
} else {
  for (const c of toSeed) console.error(`  [${c.ats.padEnd(16)}] ${c.slug.padEnd(30)} ${c.name}`);
  console.error(`\n   (dry run — nothing written)\n`);
}
process.exit(0);
