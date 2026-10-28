/**
 * providers/teamtailor.mjs
 * GET https://{slug}.teamtailor.com/jobs.rss
 * No auth. RSS 2.0 with Teamtailor extensions: <pubDate>, <link>,
 * <remoteStatus> (none | hybrid | fully), <tt:locations>, <tt:department>.
 * Verified live 2026-10-23 (lumapps: 22 jobs). The <link> may point at the
 * company's custom careers domain rather than *.teamtailor.com.
 *
 * Parsed with a small dependency-free extractor: the feed is flat and
 * machine-generated, so a full XML parser isn't needed.
 */
import { fetchText, normalizeLocation } from '../lib/http.mjs';

export const ATS = 'teamtailor';

export async function fetchAll(company, opts = {}) {
  const url = `https://${company.slug}.teamtailor.com/jobs.rss`;
  if (opts.verbose) console.error(`  → GET ${url}`);
  const xml = await fetchText(url, { timeoutMs: 20_000 });
  return parseTeamtailorRss(xml).map(item => normalize(item, company));
}

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&amp;': '&' };
const decode = s => String(s ?? '')
  .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
  .replace(/&(lt|gt|quot|apos|#39);/g, m => ENTITIES[m])
  .replace(/&amp;/g, '&')
  .trim();
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
};

export function parseTeamtailorRss(xml) {
  const items = String(xml).match(/<item>[\s\S]*?<\/item>/g) || [];
  return items.map(item => ({
    title: tag(item, 'title'),
    description: tag(item, 'description'),
    pubDate: tag(item, 'pubDate'),
    link: tag(item, 'link'),
    guid: tag(item, 'guid'),
    remoteStatus: tag(item, 'remoteStatus'),
    department: tag(item, 'tt:department'),
    locations: (item.match(/<tt:location>[\s\S]*?<\/tt:location>/g) || []).map(l => ({
      name: tag(l, 'tt:name'), city: tag(l, 'tt:city'), country: tag(l, 'tt:country'),
    })),
  }));
}

function normalize(item, company) {
  const remote = /fully|remote/i.test(item.remoteStatus);
  const loc = item.locations.map(l => [l.city || l.name, l.country].filter(Boolean).join(', ')).filter(Boolean).join('; ');
  const date = item.pubDate ? new Date(item.pubDate) : null;
  return {
    url:       item.link,
    title:     item.title,
    company:   company.name,
    location:  normalizeLocation(remote ? (loc ? `${loc} (Remote)` : 'Remote') : loc),
    remote,
    ats:       ATS,
    posted_at: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    raw: { id: item.guid, ...item },
  };
}
