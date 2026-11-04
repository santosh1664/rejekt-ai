/**
 * lib/cover-letter.mjs: a cover letter written for one job from the person's resume profile, the way
 * lib/resume-tailor.mjs rewrites the resume. The model may only use what the profile shows; a letter that
 * adds a number the profile and posting don't contain, leaves a {placeholder}, or is too short or long is
 * thrown away and the person's own template (if any) is used instead.
 *
 *   const { letter, source } = await writeCoverLetter(sections, job, { template, complete })
 *   source: 'model' | 'template' | 'none'
 */
import { completeJSON } from './llm.mjs';
import { renderCoverLetter } from './resume-render.mjs';

const SYSTEM = `You write cover letters for job applications. Rules:
- First person, plain and specific, 170 to 260 words, three short paragraphs, no headings.
- Use ONLY facts from the candidate profile: employers, roles, skills, projects, numbers. Never invent a skill, employer, degree, number or year.
- Connect two or three of the candidate's real achievements to what this posting asks for. Name the company and the role once each.
- No placeholders, no brackets, no "Dear Hiring Manager" boilerplate openers like "I am writing to apply". Start with why this role, then the evidence.
- Close with one short sentence. Do not add a signature block; the signature line is added for you.
Reply as JSON: {"letter": "..."}`;

const words = s => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const numbersIn = s => new Set(String(s || '').match(/\d[\d,.]*%?/g)?.map(n => n.replace(/[,.]$/, '')) || []);

export function profileFacts(sections = {}) {
  const exp = (sections.experience || []).slice(0, 4).map(e => `${e.title} at ${e.company} (${e.start || ''} - ${e.end || 'Present'})\n${(e.bullets || []).slice(0, 5).map(b => `- ${b}`).join('\n')}`);
  const proj = (sections.projects || []).slice(0, 2).map(p => `${p.name}: ${(p.bullets || []).slice(0, 2).join(' ')}`);
  const skills = Array.isArray(sections.skills) ? sections.skills.flatMap(s => s.items || s.skills || s).slice(0, 40).join(', ') : '';
  return [`Name: ${sections.personal?.fullName || ''}`, sections.summary && `Summary: ${sections.summary}`, exp.length && `Experience:\n${exp.join('\n')}`, proj.length && `Projects:\n${proj.join('\n')}`, skills && `Skills: ${skills}`].filter(Boolean).join('\n\n');
}

/** null when the letter is fine, else why not */
export function checkLetter(letter, facts, job) {
  const n = words(letter);
  if (n < 90 || n > 330) return `${n} words`;
  if (/[{}\[\]]|\bTODO\b|lorem/i.test(letter)) return 'has a placeholder';
  const allowed = numbersIn(`${facts} ${job.title} ${job.company} ${job.description || ''}`);
  const invented = [...numbersIn(letter)].filter(x => !allowed.has(x));
  return invented.length ? `invents ${invented.join(', ')}` : null;
}

export async function writeCoverLetter(sections, job, { template = '', complete = completeJSON, llm = { timeoutMs: 90_000 } } = {}) {
  const fallback = renderCoverLetter(template, job);
  const facts = profileFacts(sections);
  try {
    const prompt = `Candidate profile:\n${facts}\n\n${template ? `The candidate's own sample, for tone only (do not copy facts from it):\n${template.slice(0, 1500)}\n\n` : ''}Job: ${job.title} at ${job.company}\nPosting:\n${String(job.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 3500)}`;
    const r = await complete({ system: SYSTEM, prompt, maxTokens: 700, temperature: 0.4 }, llm);
    const body = String(r.json?.letter || '').trim();
    const why = checkLetter(body, facts, job);
    if (!why) {
      const name = sections.personal?.fullName;
      return { letter: name ? `${body}\n\nSincerely,\n${name}` : body, source: 'model', model: `${r.provider}:${r.model}` };
    }
    return { letter: fallback, source: fallback ? 'template' : 'none', rejected: why };
  } catch (err) {
    return { letter: fallback, source: fallback ? 'template' : 'none', rejected: err.message };
  }
}
