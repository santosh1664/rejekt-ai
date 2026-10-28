#!/usr/bin/env python3
"""
ml/extract_fields.py

Reads job descriptions from PostgreSQL and extracts structured filter fields:
  - career_level     (INTERN/ENTRY/MID/SENIOR/LEAD/MANAGER/EXECUTIVE/UNKNOWN)
  - min_exp_years / max_exp_years
  - degree_required  (JSONB array)
  - sponsorship_status (AVAILABLE/NOT_AVAILABLE/RESTRICTED/NOT_MENTIONED/UNCLEAR)
  - employment_type  (FULL_TIME/PART_TIME/CONTRACT/TEMPORARY/INTERNSHIP/UNKNOWN)
  - workplace_type   (REMOTE/HYBRID/ONSITE/FLEXIBLE/UNKNOWN)
  - salary_min_annual / salary_max_annual / salary_currency
  - skill_tags       (TEXT[])

Usage:
  pip install psycopg2-binary python-dotenv
  python3 ml/extract_fields.py [--limit N] [--offset N] [--dry-run]

Environment: reads DATABASE_URL from .env.local
"""

import os, re, sys, json, hashlib, argparse, time
from pathlib import Path

# ── Load env ───────────────────────────────────────────────────────────────────
env_file = Path(__file__).parent.parent / '.env.local'
if env_file.exists():
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, _, v = line.partition('=')
            v = v.strip().strip('"').strip("'")
            os.environ.setdefault(k.strip(), v)

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("ERROR: pip install psycopg2-binary", file=sys.stderr)
    sys.exit(1)

VERSION = "1.1.0"

# ═══════════════════════════════════════════════════════════════════════════════
# REGEX PATTERNS
# ═══════════════════════════════════════════════════════════════════════════════

# ── Career level ───────────────────────────────────────────────────────────────
CAREER_PATTERNS = [
    ('INTERN',    r'\b(intern|internship|co[-\s]?op|trainee|apprentice)\b'),
    ('ENTRY',     r'\b(entry[\s-]level|junior|jr\.?\b|associate\s+(?:engineer|developer|analyst)|new\s+grad(?:uate)?|0[\s-]?(?:to|-)[\s-]?[12][\s+]year)\b'),
    ('SENIOR',    r'\b(senior|sr\.?\s|staff\s+(?:engineer|developer|scientist|analyst))\b'),
    ('LEAD',      r'\b(lead\s+(?:engineer|developer|architect|scientist)|tech(?:nical)?\s+lead|principal\s+(?:engineer|developer|architect|scientist))\b'),
    ('MANAGER',   r'\b(engineering\s+manager|(?:team|project|program)\s+lead|director\s+of|head\s+of|vp\s+of|vice\s+president)\b'),
    ('EXECUTIVE', r'\b(cto|ceo|cpo|chief\s+(?:technology|product|engineering|data)\s+officer|svp|evp|c-suite)\b'),
    ('MID',       r'\b(mid[\s-]level|mid[\s-]senior|[23]\+?\s+year|intermediate)\b'),
]

# ── Years of experience ────────────────────────────────────────────────────────
EXP_PATTERNS = [
    # "3-5 years", "3 to 5 years", "3+ years"
    re.compile(r'(\d+)\s*(?:-|to|–)\s*(\d+)\s*\+?\s*year', re.I),
    re.compile(r'(\d+)\s*\+\s*year',                         re.I),
    re.compile(r'minimum\s+(?:of\s+)?(\d+)\s+year',          re.I),
    re.compile(r'at\s+least\s+(\d+)\s+year',                 re.I),
]

# ── Degree ─────────────────────────────────────────────────────────────────────
DEGREE_PATTERNS = [
    ('PHD',        r"\b(ph\.?d\.?|doctorate|doctoral)\b"),
    ('MASTER',     r"\b(master'?s?|m\.?s\.?\b|mba|m\.?eng\.?)\b"),
    ('BACHELOR',   r"\b(bachelor'?s?|b\.?s\.?\b|b\.?a\.?\b|b\.?eng\.?|undergraduate\s+degree|4[\s-]year\s+degree)\b"),
    ('ASSOCIATE',  r"\b(associate'?s?|a\.?a\.?\b|a\.?s\.?\b|2[\s-]year\s+degree)\b"),
]
DEGREE_REQUIRED_SIGNAL  = re.compile(r'\b(required|must\s+have|minimum|you\s+must)\b', re.I)
DEGREE_PREFERRED_SIGNAL = re.compile(r'\b(preferred|plus|desired|ideally|nice[\s-]to[\s-]have|a\s+plus)\b', re.I)

# ── Sponsorship ────────────────────────────────────────────────────────────────
SPONSOR_AVAILABLE   = re.compile(r'\b(visa\s+sponsor(?:ship)?|work\s+authoriz(?:ation)?\s+sponsor|h[\s-]?1[\s-]?b\s+sponsor|we\s+(?:do|will)\s+sponsor|sponsor(?:ship)?\s+available|authorized\s+to\s+sponsor)\b', re.I)
# NOT_AVAIL: any phrasing where a negative word is near 'sponsor',
# or explicit denial phrases. Checked BEFORE SPONSOR_AVAILABLE.
SPONSOR_NOT_AVAIL   = re.compile(
    r'(?:not|no|cannot|can\s+not|unable\s+to|don\'?t|does\s+not|do\s+not'
    r'|will\s+not|are\s+not|is\s+not)\s+(?:\w+\s+){0,3}?sponsor'
    r'|sponsorship\s+(?:is\s+)?(?:not\s+(?:available|offered|provided|possible)|unavailable|not\s+offered)'
    r'|no\s+(?:visa\s+)?sponsorship'
    r'|must\s+(?:already\s+)?be\s+(?:authorized|eligible|permitted)\s+to\s+work'
    r'|must\s+not\s+require\s+(?:visa\s+)?sponsor'
    r'|not\s+in\s+a\s+position\s+to\s+sponsor',
    re.I)
SPONSOR_RESTRICTED  = re.compile(r'\b(u\.?s\.?\s+(?:citizen|citizens?hip|national|permanent\s+resident|green\s+card|security\s+clearance)|secret\s+clearance|ts\/sci|top\s+secret)\b', re.I)
AUTHORIZED_SIGNAL   = re.compile(r'\b(authorized\s+to\s+work|work\s+authoriz|eligible\s+to\s+work)\b', re.I)

# ── Employment type ────────────────────────────────────────────────────────────
EMP_PATTERNS = [
    ('FULL_TIME',   r'\b(full[\s-]time|permanent\s+position|regular\s+(?:full[\s-]time|employee))\b'),
    ('PART_TIME',   r'\b(part[\s-]time)\b'),
    ('CONTRACT',    r'\b(contract(?:or)?|c2c|corp[\s-]to[\s-]corp|w2\s+contract|independent\s+contractor|1099|consulting\s+role|temporary\s+to\s+hire|contract[\s-]to[\s-]hire)\b'),
    ('TEMPORARY',   r'\b(temporary|temp\b|seasonal|fixed[\s-]term)\b'),
    ('INTERNSHIP',  r'\b(intern(?:ship)?|co[\s-]?op\s+position|summer\s+program)\b'),
]

# ── Workplace type ─────────────────────────────────────────────────────────────
WORKPLACE_PATTERNS = [
    ('REMOTE',  r'\b(fully[\s-]remote|100%\s*remote|remote[\s-]first|remote[\s-]only|work[\s-]from[\s-]home|wfh\b|distributed\s+team|location[\s:]+remote)\b'),
    ('HYBRID',  r'\b(hybrid|(?:remote|in[\s-]office)\s+(?:\/|and|or|with)\s+(?:remote|in[\s-]office)|(?:\d+)\s+day[s]?\s+(?:in\s+)?(?:office|remote))\b'),
    ('ONSITE',  r'\b(on[\s-]?site|in[\s-]?office|in[\s-]?person|must\s+be\s+local|local\s+candidate|required\s+to\s+(?:be\s+in|work\s+from)\s+office|no\s+remote)\b'),
    ('FLEXIBLE', r'\b(flexible\s+work|flexible\s+location|work\s+from\s+anywhere|global\s+remote|optional\s+remote)\b'),
]

# ── Salary ─────────────────────────────────────────────────────────────────────
SALARY_RANGE  = re.compile(r'\$\s*(\d{2,3}(?:,\d{3})?(?:\.\d+)?)\s*[kK]?\s*(?:-|to|–)\s*\$?\s*(\d{2,3}(?:,\d{3})?(?:\.\d+)?)\s*[kK]?', re.I)
SALARY_SINGLE = re.compile(r'\$\s*(\d{2,3}(?:,\d{3})?(?:\.\d+)?)\s*[kK]?\s*(?:per\s+(?:year|annum|yr)|annual(?:ly)?|/\s*year)', re.I)
SALARY_HOURLY = re.compile(r'\$\s*(\d{2,3}(?:\.\d+)?)\s*(?:-|to|–)?\s*\$?\s*(\d{2,3}(?:\.\d+)?)?\s*(?:per\s+hour|/\s*hr?\.?|an\s+hour)', re.I)

# ── Skills ─────────────────────────────────────────────────────────────────────
SKILLS = [
    # Languages
    'python','javascript','typescript','java','go','golang','rust','c++','c#','ruby','php',
    'swift','kotlin','scala','r\b','matlab','perl','bash','shell','powershell',
    # Frontend
    'react','react.js','reactjs','vue','vue.js','angular','svelte','next.js','nextjs','nuxt',
    'html','css','sass','tailwind','webpack','vite','graphql',
    # Backend / infra
    'node.js','nodejs','django','flask','fastapi','spring','rails','laravel','express',
    'rest','grpc','microservices','kafka','rabbitmq','celery','redis',
    # Data / ML
    'sql','postgresql','postgres','mysql','mongodb','sqlite','elasticsearch','snowflake',
    'bigquery','spark','hadoop','airflow','dbt','pandas','numpy','scikit-learn',
    'tensorflow','pytorch','keras','llm','openai','langchain','hugging face',
    # Cloud / DevOps
    'aws','azure','gcp','google cloud','kubernetes','k8s','docker','terraform',
    'ansible','ci/cd','jenkins','github actions','gitlab ci','linux','unix',
    # Other tech
    'git','jira','figma','tableau','power bi','salesforce','sap','servicenow',
]
SKILL_RE = re.compile(
    r'\b(' + '|'.join(re.escape(s) for s in SKILLS) + r')\b',
    re.I
)


# ═══════════════════════════════════════════════════════════════════════════════
# EXTRACTION FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════════

def extract_career_level(text):
    text_lower = text.lower()
    for level, pat in CAREER_PATTERNS:
        if re.search(pat, text_lower):
            return level
    return 'UNKNOWN'


def extract_experience_years(text):
    min_yr = max_yr = None
    for pat in EXP_PATTERNS:
        m = pat.search(text)
        if m:
            groups = [int(g) for g in m.groups() if g is not None]
            if len(groups) == 2:
                a, b = sorted(groups)
                if 0 <= a <= 30 and 0 <= b <= 30:
                    min_yr = a if min_yr is None else min(min_yr, a)
                    max_yr = b if max_yr is None else max(max_yr, b)
            elif len(groups) == 1:
                a = groups[0]
                if 0 <= a <= 30:
                    min_yr = a if min_yr is None else min(min_yr, a)
    return min_yr, max_yr


def extract_degrees(text):
    results = []
    text_lower = text.lower()
    for degree, pat in DEGREE_PATTERNS:
        m = re.search(pat, text_lower)
        if m:
            # Look for requirement signal in nearby context (±150 chars)
            start = max(0, m.start() - 150)
            end   = min(len(text_lower), m.end() + 150)
            ctx   = text_lower[start:end]
            if DEGREE_REQUIRED_SIGNAL.search(ctx):
                req = 'REQUIRED'
            elif DEGREE_PREFERRED_SIGNAL.search(ctx):
                req = 'PREFERRED'
            else:
                req = 'NOT_MENTIONED'
            results.append({'degree': degree, 'requirement': req})
    return results


def extract_sponsorship(text):
    if SPONSOR_NOT_AVAIL.search(text):
        return 'NOT_AVAILABLE'
    if SPONSOR_RESTRICTED.search(text):
        return 'RESTRICTED'
    if SPONSOR_AVAILABLE.search(text):
        return 'AVAILABLE'
    if AUTHORIZED_SIGNAL.search(text):
        return 'NOT_AVAILABLE'  # "must be authorized" = no sponsorship
    return 'NOT_MENTIONED'


def extract_employment_type(text):
    text_lower = text.lower()
    for emp_type, pat in EMP_PATTERNS:
        if re.search(pat, text_lower):
            return emp_type
    return 'UNKNOWN'


def extract_workplace_type(text, existing_remote=None):
    text_lower = text.lower()
    for wp_type, pat in WORKPLACE_PATTERNS:
        if re.search(pat, text_lower):
            return wp_type
    # Fall back to existing remote boolean
    if existing_remote is True:
        return 'REMOTE'
    if existing_remote is False:
        return 'ONSITE'
    return 'UNKNOWN'


def parse_salary_num(s):
    """Parse '$120k' or '$120,000' or '$120.5' → int annualized."""
    s = s.replace(',', '').strip()
    val = float(s)
    if val < 1000:   # it's in thousands
        val *= 1000
    return int(val)


def extract_salary(text):
    min_sal = max_sal = None
    currency = 'USD'

    # Range: $80k-$120k or $80,000-$120,000
    m = SALARY_RANGE.search(text)
    if m:
        a = parse_salary_num(m.group(1))
        b = parse_salary_num(m.group(2))
        # Sanity: annual salary $20k–$1M
        if 20_000 <= a <= 1_000_000 and 20_000 <= b <= 1_000_000:
            min_sal, max_sal = sorted([a, b])

    # Single annual
    if min_sal is None:
        m = SALARY_SINGLE.search(text)
        if m:
            a = parse_salary_num(m.group(1))
            if 20_000 <= a <= 1_000_000:
                min_sal = max_sal = a

    # Hourly → annualize (×2080)
    if min_sal is None:
        m = SALARY_HOURLY.search(text)
        if m:
            a = float(m.group(1))
            b = float(m.group(2)) if m.group(2) else a
            min_a = int(min(a, b) * 2080)
            max_a = int(max(a, b) * 2080)
            if 20_000 <= min_a <= 500_000:
                min_sal, max_sal = min_a, max_a

    return min_sal, max_sal, currency


def extract_skills(text):
    found = set()
    for m in SKILL_RE.finditer(text):
        found.add(m.group(0).lower())
    # Normalize some
    normalized = []
    for s in sorted(found):
        if s in ('react.js', 'reactjs'):    s = 'react'
        elif s in ('vue.js',):               s = 'vue'
        elif s in ('node.js', 'nodejs'):     s = 'node.js'
        elif s in ('next.js', 'nextjs'):     s = 'next.js'
        elif s in ('golang',):               s = 'go'
        elif s in ('postgres', 'postgresql'):s = 'postgresql'
        normalized.append(s)
    return list(dict.fromkeys(normalized))  # deduplicate preserving order


def extract_all(title, description, existing_remote=None):
    """Run all extractors on combined title + description text."""
    text = f"{title or ''}\n{description or ''}"

    career_level    = extract_career_level(text)
    min_exp, max_exp= extract_experience_years(text)
    degrees         = extract_degrees(text)
    sponsorship     = extract_sponsorship(text)
    emp_type        = extract_employment_type(text)
    workplace       = extract_workplace_type(text, existing_remote)
    sal_min, sal_max, currency = extract_salary(text)
    skills          = extract_skills(text)

    # Confidence: rough heuristic based on description length
    desc_len   = len(description or '')
    confidence = min(1.0, 0.4 + (desc_len / 3000) * 0.6) if desc_len > 50 else 0.2

    return {
        'career_level':      career_level,
        'min_exp_years':     min_exp,
        'max_exp_years':     max_exp,
        'degree_required':   json.dumps(degrees),
        'sponsorship_status':sponsorship,
        'employment_type':   emp_type,
        'workplace_type':    workplace,
        'salary_min_annual': sal_min,
        'salary_max_annual': sal_max,
        'salary_currency':   currency,
        'skill_tags':        skills,
        'extraction_confidence': round(confidence, 3),
        'extraction_version':    VERSION,
        'description_hash':  hashlib.md5((description or '').encode()).hexdigest(),
    }


# ═══════════════════════════════════════════════════════════════════════════════
# DATABASE RUNNER
# ═══════════════════════════════════════════════════════════════════════════════

# Keyset (cursor) pagination on (discovered, id), NOT OFFSET: each processed
# row gets its description_hash set to match, so it drops out of this WHERE
# clause — OFFSET against that shrinking result set skips roughly half the
# remaining rows every batch (same class of bug as scripts/ml-recategorize.mjs
# earlier this session). "(discovered, id) < (cursor)" stays correct
# regardless of whether the matching set shrinks (live run) or stays fixed
# (--dry-run, where nothing is written).
FETCH_SQL_FIRST = """
    SELECT id, title, coalesce(description, '') as description, remote, discovered
    FROM jobs
    WHERE active = TRUE
      AND (description_hash IS NULL
           OR extraction_version IS DISTINCT FROM '1.1.0'
           OR description_hash != md5(coalesce(description,'')))
    ORDER BY discovered DESC, id DESC
    LIMIT %s OFFSET %s
"""

FETCH_SQL_CURSOR = """
    SELECT id, title, coalesce(description, '') as description, remote, discovered
    FROM jobs
    WHERE active = TRUE
      AND (description_hash IS NULL
           OR extraction_version IS DISTINCT FROM '1.1.0'
           OR description_hash != md5(coalesce(description,'')))
      AND (discovered, id) < (%s, %s)
    ORDER BY discovered DESC, id DESC
    LIMIT %s
"""

UPDATE_SQL = """
    UPDATE jobs SET
        career_level         = %s,
        min_exp_years        = %s,
        max_exp_years        = %s,
        degree_required      = %s,
        sponsorship_status   = %s,
        employment_type      = %s,
        workplace_type       = %s,
        salary_min_annual    = %s,
        salary_max_annual    = %s,
        salary_currency      = %s,
        skill_tags           = %s,
        extraction_confidence= %s,
        extraction_version   = %s,
        description_hash     = %s
    WHERE id = %s
"""

def run(limit=None, offset=0, dry_run=False, batch_size=500):
    db_url = os.environ.get('DATABASE_URL', '')
    if not db_url:
        print("ERROR: DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)

    # psycopg2 wants 'postgresql://' but handles 'postgres://' too
    conn = psycopg2.connect(db_url, sslmode='require')
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)

    total_processed = 0
    total_updated   = 0
    max_rows        = limit
    cursor          = None  # (discovered, id) of the last row seen; None = first batch

    print(f"Starting extraction (batch_size={batch_size}, dry_run={dry_run})…")
    t0 = time.time()

    while True:
        this_batch = batch_size if max_rows is None else min(batch_size, max_rows - total_processed)
        if this_batch <= 0:
            break

        if cursor is None:
            cur.execute(FETCH_SQL_FIRST, (this_batch, offset))
        else:
            cur.execute(FETCH_SQL_CURSOR, (cursor[0], cursor[1], this_batch))
        rows = cur.fetchall()
        if not rows:
            break
        cursor = (rows[-1]['discovered'], rows[-1]['id'])

        updates = []
        for row in rows:
            result = extract_all(row['title'], row['description'], row['remote'])
            updates.append((
                result['career_level'],
                result['min_exp_years'],
                result['max_exp_years'],
                result['degree_required'],
                result['sponsorship_status'],
                result['employment_type'],
                result['workplace_type'],
                result['salary_min_annual'],
                result['salary_max_annual'],
                result['salary_currency'],
                result['skill_tags'],
                result['extraction_confidence'],
                result['extraction_version'],
                result['description_hash'],
                row['id'],
            ))

        if not dry_run:
            psycopg2.extras.execute_batch(cur, UPDATE_SQL, updates, page_size=200)
            conn.commit()

        total_processed += len(rows)
        total_updated   += len(updates)

        elapsed = time.time() - t0
        rate    = total_processed / elapsed if elapsed > 0 else 0
        print(f"  Processed {total_processed:,} rows  |  {rate:.0f} rows/s", end='\r')

    print(f"\nDone ✓  {total_updated:,} jobs updated in {time.time()-t0:.1f}s")
    cur.close()
    conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Extract ML fields from job descriptions')
    parser.add_argument('--limit',     type=int, default=None, help='Max rows to process')
    parser.add_argument('--offset',    type=int, default=0,    help='Start offset')
    parser.add_argument('--batch-size',type=int, default=500,  help='DB batch size')
    parser.add_argument('--dry-run',   action='store_true',    help='Extract but do not write to DB')
    args = parser.parse_args()
    run(limit=args.limit, offset=args.offset, dry_run=args.dry_run, batch_size=args.batch_size)
