/**
 * Tests for the resume model, training data, Tsenta import and Applied search
 * (docs/resume-model.md).
 *
 *   node scripts/test-resume-model.mjs              pure checks
 *   DATABASE_URL=postgres://…@localhost/jobs_test node scripts/test-resume-model.mjs --db
 *
 * Uses synthetic fixtures (fixtures/tsenta, fixtures/resumes), never your data.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { mentions } from '../lib/skills.mjs';
import { spawn } from 'node:child_process';
import { htmlToText, convertTsentaResume, importTsentaHistory } from '../lib/import-tsenta.mjs';
import { alignToProfile, buildExamples, splitExamples, similarity } from '../lib/rewriter-dataset.mjs';
import { unsupportedClaims, REWRITER_SYSTEM, splitSentences, jobSkillMap, tailorResume } from '../lib/resume-tailor.mjs';
import { extractResumeSections } from '../lib/resume-extract.mjs';
import { snippetAround } from '../lib/applied-search.mjs';
import { parseJsonReply, llmConfig } from '../lib/llm.mjs';
import { addPostingSkills, acceptMatchReply, tailorResumeToMatch, postingSkills, withStyleExamples, MATCH_SYSTEM, SUMMARY_SYSTEM, blockBudget, copiesPosting, plainWords, polishForPosting } from '../lib/resume-match.mjs';
import { alignForMatch, buildMatchExamples, pickStyleExamples } from '../lib/rewriter-dataset.mjs';
import { withDefaults } from '../lib/resume-profiles.mjs';
import { buildBank, pickFromBank } from '../lib/bullet-bank.mjs';
import { atsScore, postingTerms } from '../lib/ats-score.mjs';
import { buildBonExamples } from '../lib/rewriter-dataset.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const FIX = new URL('../fixtures/tsenta/', import.meta.url).pathname;
let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) { failures++; if (detail !== undefined) console.log('      ', typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)); }
}
const jsonl = f => readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

// ─── Pure ────────────────────────────────────────────────────────────────────
const profile = extractResumeSections(readFileSync(new URL('../fixtures/resumes/sample-a.txt', import.meta.url), 'utf8'));
const detail = jsonl(FIX + 'details.jsonl')[0];
const sent = convertTsentaResume({ ...detail.resume, personalInformation: { ...detail.resume.personalInformation, dateOfBirth: '2000-01-01', address: '1 Main St' }, diversityEquityInclusion: { gender: 'x' } });

check('HTML postings become readable text with bullets', htmlToText(detail.job.description) === 'AcmePay builds payment rails.\n\n• Build Java and Spring Boot services for card payments\n• Run Kafka event pipelines\n\nBonus: Kubernetes & Terraform.', htmlToText(detail.job.description));
check('Tsenta resume converts: name, roles, current role, bullets', sent.personal.fullName === 'Alex Rivera' && sent.experience.length === 2 && sent.experience[0].current === true && sent.experience[0].endDate === '' && sent.experience[0].bullets.length === 4, sent.experience[0]);
check('Tsenta resume converts: skills in order, education, projects', sent.skills[0].group === 'Languages' && sent.education[0].school === 'University of North Texas' && sent.projects[0].name === 'Interview Coach');
check('Converted resume drops date of birth, address and EEO answers', !/2000-01-01|1 Main St|gender/.test(JSON.stringify(sent)));

const claims = unsupportedClaims(sent, profile).map(s => s.toLowerCase());
check('claims check flags skills the profile never shows', claims.includes('terraform') && claims.includes('istio'), claims);
check("claims check doesn't flag skills the profile has", !claims.includes('java') && !claims.includes('kubernetes') && !claims.includes('python'), claims);

const { blocks, stats } = alignToProfile(sent, profile);
const out = blocks.flatMap(b => b.output).join('\n');
check('alignment keeps an honest rewrite paired with its original', blocks.some(b => b.output.includes('Designed secure, JWT-authenticated REST APIs serving 50K+ daily requests for payment workflows.') && b.input.includes('Designed secure REST APIs with JWT auth serving 50K+ daily requests.')), blocks);
check('alignment drops a rewrite that adds a skill (Terraform)', !/Terraform/.test(out) && stats.rejected >= 1, stats);
check('alignment drops an invented bullet with no original (Istio migration)', !/Istio/.test(out) && stats.unmatched >= 1, stats);
check('similarity is word overlap', similarity('Built REST APIs in Java', 'Built Java REST APIs') > 0.7 && similarity('a b c', 'x y z') === 0);

const appRow = { id: 9, source: 'app', mode: 'ai', sent: true, outcome: 'INTERVIEWING', job_title: 'Backend Engineer', company: 'Initech', job_description: 'Java Spring Boot Kafka',
  report: { blocks: [{ kind: 'role', title: 'Software Engineer', company: 'Northwind Bank', input: ['Built APIs in Java.', 'Ran Docker builds.'], output: ['Built Java APIs for payments.', 'Ran Docker builds.'] },
    { kind: 'role', title: 'X', company: 'Y', input: ['Same.'], output: ['Same.'] }] } };
const tsRow = { id: 10, source: 'tsenta', mode: 'tsenta', sent: true, job_title: 'Backend Engineer, Payments', company: 'AcmePay', job_description: htmlToText(detail.job.description), resume_after: sent };
const { examples, stats: ex } = buildExamples([appRow, tsRow], profile, { style: 'honest' });
const ex0 = examples[0]?.messages;
check('dataset: rewrites made here become chat examples (unchanged blocks skipped)', ex.fromApp === 1 && ex0?.[0].content === REWRITER_SYSTEM && ex0[1].content.includes('Posting: Backend Engineer at Initech') && JSON.parse(ex0[2].content).bullets[0] === 'Built Java APIs for payments.', ex);
check('dataset: Tsenta resumes become examples with only honest bullets', ex.fromTsenta >= 1 && examples.filter(e => e.meta.source === 'tsenta').every(e => !/Terraform|Istio/.test(e.messages[2].content)), ex);
check('dataset: every example has the same bullet count in and out', examples.every(e => { const u = e.messages[1].content; return JSON.parse(u.slice(u.lastIndexOf('Bullets:') + 8)).length === JSON.parse(e.messages[2].content).bullets.length; }));
check('dataset: without a profile, Tsenta rows are skipped', buildExamples([tsRow], null, { style: 'honest' }).stats.fromTsenta === 0);
const many = Array.from({ length: 60 }, (_, i) => ({ messages: [], meta: { company: `C${i}`, title: 'T' } }));
const s1 = splitExamples(many); const s2 = splitExamples(many);
check('dataset split is deterministic and has a validation set', JSON.stringify(s1) === JSON.stringify(s2) && s1.valid.length > 0 && s1.train.length > s1.test.length);

const snip = snippetAround('We run Kafka event pipelines at scale every day.', 'kafka', 10);
check('posting snippet shows the match in context', snip.match === 'Kafka' && snip.before.endsWith('run ') && snip.after.startsWith(' event'), snip);
check('model reply parsing tolerates text around the JSON', parseJsonReply('Sure! {"bullets":["a"]} hope that helps').bullets[0] === 'a');
check('local model is the default provider', llmConfig({}).provider === 'ollama' && llmConfig({ LLM_PROVIDER: 'anthropic' }).provider === 'anthropic');


// ─── "Match the job" (lib/resume-match.mjs) ─────────────────────────────────
const dataJob = { title: 'Data Engineer', company: 'Initech', description: 'Build ETL pipelines with Airflow and dbt. Python, SQL and Kafka required. Terraform on AWS. Strong communication.', skills: ['airflow', 'json', 'communication', 'etl/elt pipelines', 'fintech experience'] };
const ps = [...postingSkills(dataJob).values()].map(x => x.name);
check('posting skills: tools kept, soft skills dropped, names tidied', ps.includes('Airflow') && ps.includes('JSON') && ps.includes('ETL/ELT Pipelines') && !ps.some(x => /communication|fintech/i.test(x)), ps);
const sk = withDefaults(profile);
const addedSk = addPostingSkills(sk, dataJob);
const groupOf = name => sk.skills.find(g => g.items.includes(name))?.group;
check('match: missing posting skills are added to the skills section', ['Airflow', 'dbt', 'Terraform'].every(x => addedSk.includes(x)) && !addedSk.includes('Python'), addedSk);
check('match: added skills land in a fitting group (Terraform with Docker/Kubernetes)', groupOf('Terraform') === groupOf('Docker'), sk.skills);
check('match: no skill is listed twice', sk.skills.flatMap(g => g.items.map(x => x.toLowerCase())).length === new Set(sk.skills.flatMap(g => g.items.map(x => x.toLowerCase()))).size);

const orig = ['Built APIs serving 50K+ daily requests.', 'Ran Docker builds.', 'Wrote tests.'];
let acc = acceptMatchReply(orig, { bullets: ['Built APIs serving 50K+ daily requests, feeding ETL pipelines in Airflow.', 'Ran Docker builds for data jobs.', 'Wrote pytest tests for dbt models.'], added: ['Designed dbt models for the warehouse.', 'Another one that is long enough to count here.'] }, { edit: 2, add: 1 });
check('match reply: edits beyond the budget keep the original', acc.edited === 2 && acc.bullets[2] === orig[2], acc);
check('match reply: new bullets are capped', acc.added.length === 1 && acc.added[0].startsWith('Designed dbt'), acc.added);
acc = acceptMatchReply(orig, { bullets: ['Built APIs serving daily requests for pipelines.', orig[1], orig[2]] }, { edit: 2, add: 0 });
check('match reply: a rewrite may drop a metric, as you did', acc.bullets[0] === 'Built APIs serving daily requests for pipelines.' && !acc.problems.length, acc.problems);
acc = acceptMatchReply(orig, { bullets: ['Built APIs serving 50K+ daily requests, cutting latency 30%.', 'Ran Docker builds.', 'Wrote tests.'] }, { edit: 3, add: 0 });
check('match reply: a rewrite that adds a number is refused', acc.bullets[0] === orig[0] && /30%/.test(acc.problems.join(' ')), acc.problems);
acc = acceptMatchReply(['Indexed 115,600 records for search.'], { bullets: ['Index 115.6K records for semantic search.'] }, { edit: 1, add: 0 });
check('match reply: the same number written another way is fine (115,600 → 115.6K)', acc.edited === 1, acc.problems);
acc = acceptMatchReply(['Contributed to frontend development for a financial-services application using Angular and React.js, building reusable UI components, forms, and client-side validation.'],
  { bullets: ['Designed and developed AI services for agent memory and continuous learning using Python and C#, enhancing agent reliability and scalability.'] }, { edit: 1, add: 0 });
check('match reply: a "rewrite" that swaps in different work is refused', acc.edited === 0 && /different work/.test(acc.problems.join(' ')), acc.problems);
acc = acceptMatchReply(['Integrated frontend modules with existing REST APIs, handling asynchronous requests, loading states, validation failures, and user-facing error messages.'],
  { bullets: ['Integrated frontend modules with backend services, handling async requests, loading states, validation failures, and clear error states, improving the day-to-day experience of internal users.'] }, { edit: 1, add: 0 });
check('match reply: a real rewrite (reworded and extended) is kept', acc.edited === 1, acc.problems);
check('summary sentences: "rejekt.ai", "Node.js" and "3.5" stay inside their sentence', JSON.stringify(splitSentences('Engineer with 3.5 years. Shipped a platform (rejekt.ai) end to end with Node.js. Holds an M.S. in CS.')) === JSON.stringify(['Engineer with 3.5 years.', 'Shipped a platform (rejekt.ai) end to end with Node.js.', 'Holds an M.S. in CS.']));
acc = acceptMatchReply(['Built REST APIs in Spring Boot for payment workflows.'], { bullets: ['Leveraged Spring Boot to build robust REST APIs for payment workflows.'] }, { edit: 1, add: 0 });
check('match reply: a rewrite that brings in clichés (leveraged, robust) is refused', acc.edited === 0 && /leveraged/i.test(acc.problems.join(' ')), acc.problems);
check('match reply: wrong bullet count is refused', acceptMatchReply(orig, { bullets: ['x'] }, { edit: 2, add: 0 }).problems.length === 1);
check('match budget follows your tailoring: every bullet reworded, at most one model-written bullet, earlier bullets from the bank',
  blockBudget('role', 0, 6).edit === 6 && blockBudget('role', 0, 6).add === 1 && blockBudget('role', 2, 4).add === 0 && blockBudget('role', 1, 5).bank === 4 && blockBudget('project', 0, 3).edit === 3, [blockBudget('role', 0, 6), blockBudget('role', 1, 5)]);

// Bullet bank (lib/bullet-bank.mjs): bullets from earlier versions come back when they fit.
const older = withDefaults(profile);
const olderCopy = JSON.parse(JSON.stringify(older));
olderCopy.experience[0].bullets.push('Built Airflow DAGs that loaded Kafka events into the warehouse with dbt transformations.', 'Organized the team offsite and holiday party for 30 people.');
const bank = buildBank([profile, olderCopy]);
const firstRole = { kind: 'role', company: older.experience[0].company, title: older.experience[0].title, bullets: older.experience[0].bullets };
const picked = pickFromBank(bank, firstRole, dataJob, 2);
check('bank: an earlier bullet that fits the posting comes back, one that does not stays out', picked.length === 1 && /Airflow DAGs/.test(picked[0]), picked);
check('bank: bullets already on the resume are not offered again', !pickFromBank(bank, { ...firstRole, bullets: [...firstRole.bullets, picked[0]] }, dataJob, 2).length);

const fakeComplete = async ({ system, prompt }) => {
  if (system === SUMMARY_SYSTEM) {
    const title = prompt.match(/Professional title: (.*)/)[1]; const years = prompt.match(/Years of experience: (.*)/)[1];
    return { json: { summary: `${title} with ${years} of experience building Python and SQL data pipelines with Airflow and Kafka.` }, provider: 'ollama', model: 'fake' };
  }
  const bullets = JSON.parse(prompt.slice(prompt.lastIndexOf('Bullets:') + 8));
  return { json: { bullets: bullets.map((b, i) => (i === 0 ? b.replace(/\.$/, ', landing the data in ETL pipelines orchestrated with Airflow.') : b)), added: [`Built dbt models on top of the Kafka event stream for ${(prompt.match(/^(?:Role|Project): (.*)$/m) || [])[1]}.`] }, provider: 'ollama', model: 'fake' };
};
// A model that stays inside what the resume shows (Python, SQL, AWS) vs. one that works the posting's tools (Airflow, dbt) in.
const okComplete = async ({ system, prompt }) => {
  if (system === SUMMARY_SYSTEM) {
    const title = prompt.match(/Professional title: (.*)/)[1]; const years = prompt.match(/Years of experience: (.*)/)[1];
    return { json: { summary: `${title} with ${years} of experience building Python and SQL data pipelines on AWS.` }, provider: 'ollama', model: 'fake' };
  }
  const bullets = JSON.parse(prompt.slice(prompt.lastIndexOf('Bullets:') + 8));
  return { json: { bullets: bullets.map((b, i) => (i === 0 ? b.replace(/\.$/, ', feeding validated records to downstream services.') : b)), added: [`Built Python and SQL jobs on AWS for ${(prompt.match(/^(?:Role|Project): (.*)$/m) || [])[1]}.`] }, provider: 'ollama', model: 'fake' };
};
const gate = addPostingSkills(withDefaults(profile), dataJob, { allow: () => false, gaps: [] });
const gapList = []; addPostingSkills(withDefaults(profile), dataJob, { allow: n => !/airflow|dbt|terraform/.test(n), gaps: gapList });
check('match: posting skills the resume does not show are gaps, not additions', !gate.length && ['Airflow', 'dbt', 'Terraform'].every(x => gapList.includes(x)), gapList);
const mu = await tailorResumeToMatch(profile, dataJob, { complete: fakeComplete });
const muText = JSON.stringify(mu.sections);
check('match: a model that works in Airflow/dbt (not on the resume) is refused everywhere', !/Airflow|dbt|Terraform/.test(muText) && mu.report.gaps.includes('Airflow') && mu.report.problems.some(x => /Airflow|dbt/.test(x)), [mu.report.gaps, mu.report.problems]);
const m = await tailorResumeToMatch(profile, dataJob, { complete: okComplete });
const P = withDefaults(profile);
check('match: employers, titles and dates are unchanged', JSON.stringify(m.sections.experience.map(e => [e.company, e.title, e.startDate, e.endDate])) === JSON.stringify(P.experience.map(e => [e.company, e.title, e.startDate, e.endDate])));
// A skill named inside a longer list entry ("AWS (ECS, EC2, S3)") is already listed: it must not come back as "Also used".
const awsResume = withDefaults({ ...profile, skills: [{ group: 'Cloud & DevOps', items: ['CI/CD', 'AWS (ECS Fargate, EC2, S3, RDS)', 'Docker'] }], experience: [{ ...profile.experience[0], bullets: ['Deployed services on AWS with Docker.'] }] });
const awsJob = { title: 'Backend Engineer', description: 'You will run services on AWS with Docker and Python.', skills: [] };
const awsOut = tailorResume(awsResume, awsJob, 'honest');
check('skills: AWS inside "AWS (ECS Fargate, EC2…)" is not added again as "Also used"', !awsOut.sections.skills.some(g => /also used/i.test(g.group) && g.items.some(i => /aws/i.test(i))) && !awsOut.report.addedToSkills.some(x => /aws/i.test(x)), awsOut.report.addedToSkills);
const vdb = tailorResume(withDefaults({ ...profile, skills: [{ group: 'Vector Databases', items: ['ChromaDB'] }], experience: [{ ...profile.experience[0], bullets: ['Built RAG over a vector database.'] }] }), { title: 'AI Engineer', description: 'Experience with a vector database and RAG.', skills: [] }, 'honest');
check('skills: a "Vector Databases" group already covers "vector database"', !vdb.report.addedToSkills.some(x => /vector/i.test(x)), vdb.report.addedToSkills);
check('skills: match mode does not add "vector database" when a "Vector Databases" group exists', !addPostingSkills(withDefaults({ ...profile, skills: [{ group: 'Vector Databases', items: ['ChromaDB'] }] }), { title: 'AI Engineer', description: 'Experience with a vector database.', skills: [] }, { gaps: [] }).some(x => /vector/i.test(x)));
check('skills: match mode does not add AWS or Docker to a list that already names them', !addPostingSkills(awsResume, awsJob, { gaps: [] }).some(x => /aws|docker/i.test(x)));
check('match: bullets are reworded toward the posting', m.report.editedBullets >= 2, m.report);
check('skill match is whole-word: "erp" is not in "enterprise"', !mentions('enterprise software', 'erp') && mentions('built erp, sap sync', 'erp') && mentions('c++ services', 'c++'));
check('match: no block ever gains bullets', P.experience.every((e, i) => m.sections.experience[i].bullets.length <= e.bullets.length) && P.projects.every((e, i) => m.sections.projects[i].bullets.length <= e.bullets.length));
// With spare bullets below the top two, a new one replaces the least relevant old one instead of growing the role.
const padded = withDefaults(profile); padded.experience.forEach(e => e.bullets.push('Attended weekly team meetings.', 'Organized the shared drive.'));
const pm = await tailorResumeToMatch(padded, dataJob, { complete: okComplete });
check('match: a new bullet replaces the weakest old one, the count stays', pm.report.addedBullets.length >= 1 && pm.sections.experience[0].bullets.length === padded.experience[0].bullets.length && pm.sections.experience[0].bullets.some(b => b.startsWith('Built Python and SQL jobs')) && !(pm.sections.experience[0].bullets.includes('Attended weekly team meetings.') && pm.sections.experience[0].bullets.includes('Organized the shared drive.')), pm.sections.experience[0].bullets);
check('match: summary rewritten for the job, keeping title and years', m.report.summaryRewritten && m.sections.summary.startsWith(P.experience[0].title) && m.sections.summary.includes('3.5 years'), m.sections.summary);
check('match: data roles put skills above experience', m.sectionOrder[1] === 'skills' && (await tailorResumeToMatch(profile, { ...dataJob, title: 'Backend Engineer' }, { complete: okComplete })).sectionOrder[1] === 'experience');
check('match: coverage never rises through skills the resume does not show', m.report.coverage === m.report.coverageBefore && !m.report.notOnProfile.length, [m.report.coverageBefore, m.report.coverage, m.report.notOnProfile]);
const mb = await tailorResumeToMatch(profile, dataJob, { complete: okComplete, bank });
check('match: a bank bullet that names a tool the resume does not show (Airflow) stays out', !mb.sections.experience[0].bullets.some(b => /Airflow DAGs/.test(b)), mb.report.addedBullets);
// Posting text pasted in as your own work, a tool from nowhere, and the posting's title in the summary.
const doxJob = { title: 'Data Scientist', company: 'Doximity', skills: ['Python', 'Pandas', 'NumPy', 'SQL'],
  description: "Leverage Doximity's extensive datasets to identify and classify behavioral patterns of medical professionals on our platform. Excellent SQL skills. Proficient in Python data analysis libraries such as Pandas and Numpy." };
check('posting copy: naming the company or pasting 6+ words is caught', copiesPosting("Built Pandas pipelines for Doximity's datasets.", doxJob) && copiesPosting('Built pipelines to identify and classify behavioral patterns of medical professionals.', doxJob) && !copiesPosting('Built Pandas and NumPy pipelines that classify user behavior from event data.', doxJob));
const doxComplete = async ({ system, prompt }) => {
  if (system === SUMMARY_SYSTEM) return { json: { summary: 'Data Scientist with 3.5 years of experience building Python and SQL pipelines over large event datasets and turning them into insights for product teams. Holds an M.S. in Computer Science.' }, provider: 'ollama', model: 'fake' };
  const bullets = JSON.parse(prompt.slice(prompt.lastIndexOf('Bullets:') + 8));
  return { json: { bullets, added: ["Built Pandas and NumPy pipelines over Doximity's extensive datasets.", 'Automated data ingestion pipelines using Apache Airflow for daily reporting jobs.', 'Wrote SQL analyses of event data to find usage patterns for the product team.'] }, provider: 'ollama', model: 'fake' };
};
const dxProfile = withDefaults(profile); dxProfile.experience.forEach(e => e.bullets.push('Attended weekly team meetings.', 'Organized the shared drive.'));
const dx = await tailorResumeToMatch(dxProfile, doxJob, { complete: doxComplete });
const allBullets = dx.sections.experience.flatMap(e => e.bullets).join('\n');
check('match: a new bullet naming the company you apply to is dropped', !/Doximity/.test(allBullets), dx.report.problems);
check('match: a new bullet naming a tool from neither resume nor posting (Airflow) is dropped', !/Airflow/.test(allBullets) && dx.report.problems.some(p => /Airflow/.test(p)), dx.report.problems);
check('match: a fitting new bullet is kept', /usage patterns/.test(allBullets));
check('match: the summary keeps your title even when the model writes the posting title', dx.report.summaryRewritten && dx.sections.summary.startsWith(withDefaults(profile).experience[0].title + ' with 3.5 years'), dx.sections.summary);
const off = await tailorResumeToMatch(profile, dataJob, { complete: async () => { throw new Error("Ollama isn't reachable"); } });
check('match without a model: gaps reported, bullets untouched, reason given', Array.isArray(off.report.gaps) && !off.report.model && /reachable/.test(off.report.aiSkipped) && JSON.stringify(off.sections.experience.map(e => [...e.bullets].sort())) === JSON.stringify(P.experience.map(e => [...e.bullets].sort())));

// ATS score (lib/ats-score.mjs)
const atsBefore = atsScore(profile, dataJob, { original: profile });
const atsAfter = atsScore(m.sections, dataJob, { original: profile });
check('ATS score: tailoring for the posting scores higher than the untailored resume', atsAfter.score > atsBefore.score && atsAfter.score <= 10, [atsBefore.score, atsAfter.score, atsAfter.issues]);
// Unsupported skills: no credit, a cap, and gaps are not held against an honest resume.
const stuffed = JSON.parse(JSON.stringify(m.sections));
stuffed.skills.push({ group: 'Data', items: ['Airflow', 'dbt', 'Terraform'] });
const atsStuffed = atsScore(stuffed, dataJob, { original: profile });
check('ATS score: skills the original never showed are capped below the training bar and named', atsStuffed.score <= 6 && atsStuffed.unsupportedAdded.length >= 3 && atsStuffed.parts.integrity < atsAfter.parts.integrity, [atsStuffed.score, atsStuffed.unsupportedAdded]);
check('ATS score: the same stuffing scored without the original is not caught (needs the original)', atsScore(stuffed, dataJob).unsupportedAdded.length === 0);
check('ATS score: posting skills the original lacks are gaps, not a penalty', atsAfter.gaps.includes('Airflow') && atsAfter.score >= atsBefore.score, [atsAfter.gaps, atsBefore.score, atsAfter.score]);
const fluffy = JSON.parse(JSON.stringify(m.sections)); fluffy.experience[0].bullets[0] += ' applying builder mindset to drive passionate innovation.';
check('ATS score: buzzword filler costs integrity', atsScore(fluffy, dataJob, { original: profile }).parts.integrity < atsAfter.parts.integrity, atsScore(fluffy, dataJob, { original: profile }).issues);
const dupd = JSON.parse(JSON.stringify(m.sections)); dupd.experience[0].bullets.push(dupd.experience[0].bullets[0] + ' again');
check('ATS score: a near-duplicate bullet costs integrity', atsScore(dupd, dataJob, { original: profile }).parts.integrity < atsAfter.parts.integrity);
const broken = JSON.parse(JSON.stringify(m.sections)); broken.experience[0].title = 'Principal Data Engineer'; broken.experience[0].bullets[1] = 'Cut cloud costs by 47% across 300 services.';
const atsBroken = atsScore(broken, dataJob, { original: profile });
check('ATS score: a changed title, a replaced bullet and a new number cost points', atsBroken.score < atsAfter.score - 1 && atsBroken.issues.some(i => /title or date/.test(i)) && atsBroken.issues.some(i => /new numbers/.test(i)), atsBroken.issues);
const reordered = JSON.parse(JSON.stringify(m.sections)); reordered.projects.reverse(); reordered.experience.forEach(e => e.bullets.reverse());
check('ATS score: projects and bullets in a different order are not counted as dropped', !atsScore(reordered, dataJob, { original: profile }).issues.some(i => /dropped/.test(i)), atsScore(reordered, dataJob, { original: profile }).issues);
const pasted = JSON.parse(JSON.stringify(m.sections)); pasted.experience[0].bullets[0] = 'Build ETL pipelines with Airflow and dbt for Initech.';
check('ATS score: posting text pasted in costs points', atsScore(pasted, dataJob, { original: profile }).issues.some(i => /pasted/.test(i)));
check('posting terms: boilerplate and company words left out', !postingTerms({ title: 'Data Engineer', company: 'Initech', description: 'Requirements:\nBuild ETL pipelines with Airflow. Build ETL pipelines with dbt.\nBenefits: medical, dental, 401(k).\nInitech Initech Initech' }).some(t => /initech|medical|dental/.test(t)));
// Best-of-N export: only versions scoring the minimum, prompts as sent, bank bullets not taught as model output.
const bonRow = { listingId: 'x1', job: { title: 'Data Engineer', company: 'Initech' }, best: { score: 9.2, report: { blocks: [
  { kind: 'role', prompt: 'P1', input: ['a', 'b'], output: ['a2', 'b'], added: ['bank bullet', 'model bullet'], modelAdded: ['model bullet'] },
  { kind: 'role', prompt: 'P2', input: ['c'], output: ['c'], added: [], modelAdded: [] },
  { kind: 'summary', prompt: 'S', input: ['old'], output: ['new summary'] }] } } };
const bon = buildBonExamples([bonRow, { ...bonRow, listingId: 'x2', best: { ...bonRow.best, score: 8.1 } }], { min: 9 });
check('best-of-N export: keeps 9+, skips unchanged blocks, excludes bank bullets from the answer', bon.stats.kept === 1 && bon.stats.below === 1 && bon.examples.length === 2
  && JSON.parse(bon.examples[0].messages[2].content).added.join() === 'model bullet' && bon.examples[0].messages[1].content === 'P1' && bon.examples[1].messages[0].content === SUMMARY_SYSTEM, bon);
// Polish (lib/resume-match.mjs): the same fixes whichever model wrote the text.
check('polish: clichés become plain words, keeping case', plainWords('Leveraging Redis, built a robust and innovative pipeline; utilized Kafka.') === 'Using Redis, built a reliable and new pipeline; used Kafka.', plainWords('Leveraging Redis, built a robust and innovative pipeline; utilized Kafka.'));
const pol = JSON.parse(JSON.stringify(withDefaults(profile)));
pol.experience[0].bullets = ['Led weekly team syncs and planning.', 'Built Airflow DAGs feeding Kafka topics.', ...pol.experience[0].bullets];
pol.summary = 'Software Engineer with 3.5 years of experience building services.';
const polJob = { title: 'Data Engineer', company: 'Initech', description: 'Requirements: Airflow, Kafka, Python and SQL.', skills: ['Airflow', 'Kafka', 'Python', 'SQL'] };
const pc = polishForPosting(pol, polJob, jobSkillMap(polJob), new Set(['airflow', 'kafka', 'python', 'sql']));
check('polish: the best-matching bullet moves to the top of the role, none removed', /Airflow DAGs/.test(pol.experience[0].bullets[0]) && pol.experience[0].bullets.length === withDefaults(profile).experience[0].bullets.length + 2 && pc.firstBullets >= 1, pol.experience[0].bullets.slice(0, 2));
check('polish: the summary names the top keywords the resume supports', /Hands-on with .*(Airflow|Kafka)/.test(pol.summary) && pc.summaryKeywords.length >= 3, pol.summary);
const am = alignForMatch(sent, profile);
check('match alignment keeps full blocks with Tsenta edits and its new bullets', am.blocks.some(b => b.kind === 'role' && b.input.length === b.output.length && b.added.some(x => /Istio/.test(x)) && b.output.some(x => /JWT-authenticated/.test(x))), am.blocks);
const mx = buildMatchExamples([tsRow], profile);
const asst = JSON.parse(mx.examples[0].messages[2].content);
check('match dataset: Tsenta resumes become full-style examples (edits and added bullets kept)', mx.stats.fromTsenta >= 1 && mx.examples[0].messages[0].content === MATCH_SYSTEM && Array.isArray(asst.added) && mx.examples.some(e => /Istio|Terraform/.test(e.messages[2].content)), mx.stats);
check('match dataset: the summary rewrite is an example too', mx.stats.summaries === 1 && mx.examples.some(e => e.messages[0].content === SUMMARY_SYSTEM));
// Your own before → after example: compared with its own original, preferred over Tsenta's.
const tailoredByYou = JSON.parse(JSON.stringify(older));
tailoredByYou.experience[0].bullets = tailoredByYou.experience[0].bullets.map((b, i) => (i === 0 ? b.replace(/\.$/, ', keeping API contracts documented for consuming teams.') : b));
tailoredByYou.experience[0].bullets.push('Work with architects and tech leads on service design and onboarding of new integrations.');
const manualRow = { id: 9, source: 'manual', mode: 'match', job_title: 'Software Engineer, AI', company: 'Acme', job_description: 'Python services, API contracts, integrations.', resume_before: older, resume_after: tailoredByYou, sent: true };
const mm = buildMatchExamples([manualRow], null);
check('your own examples become training examples even without a default profile', mm.stats.fromManual >= 1 && mm.examples.some(e => /architects and tech leads/.test(e.messages[2].content)), mm.stats);
const seMine = pickStyleExamples([tsRow, manualRow], profile);
check('few-shot: your own examples come first', /API contracts documented/.test(seMine.edits[0]?.after || '') && /architects/.test(seMine.added[0]?.after || ''), seMine);
const se = pickStyleExamples([tsRow], profile);
check('few-shot: real before → after pairs from your history go into the instructions', se.edits.length >= 1 && withStyleExamples(MATCH_SYSTEM, se).includes('Before: ') && withStyleExamples(MATCH_SYSTEM, null) === MATCH_SYSTEM, se);

// ─── Database + API ──────────────────────────────────────────────────────────
if (process.argv.includes('--db')) await dbTests();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

async function dbTests() {
  const url = process.env.DATABASE_URL || '';
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) { console.log('SKIP  --db: DATABASE_URL must point at localhost'); failures++; return; }
  const { query, closePool } = await import('../lib/db.mjs');
  const { searchApplied } = await import('../lib/applied-search.mjs');
  const { createResumeProfile, updateResumeProfile } = await import('../lib/resume-profiles.mjs');
  const { trackApplication, updateApplication } = await import('../lib/applications.mjs');
  const { prepareApplication } = await import('../autoapply/engine.mjs');
  const { listRewritesForExport, rewriteStats, addManualExample, listManualExamples, loadBulletBank } = await import('../lib/rewrites.mjs');
  const USER = '00000000-0000-4000-8000-00000000a771';
  const cleanup = async () => {
    await query(`DELETE FROM resume_rewrites WHERE user_id = $1`, [USER]);
    await query(`DELETE FROM applications WHERE user_id = $1`, [USER]);
    await query(`DELETE FROM resume_profiles WHERE user_id = $1`, [USER]);
    await query(`DELETE FROM user_profiles WHERE user_id = $1`, [USER]);
    await query(`DELETE FROM jobs WHERE fingerprint = 'rmtest0000000001'`);
  };
  // Fake Ollama: rewords the first word of every bullet.
  const ollama = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const send = o => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/tags') return send({ models: [{ name: 'test-model:latest' }] });
    const prompt = JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content;
    if (!prompt.includes('Bullets:')) return send({ message: { content: JSON.stringify({ summary: 'x' }) } });
    const bullets = JSON.parse(prompt.slice(prompt.lastIndexOf('Bullets:') + 8));
    send({ message: { content: JSON.stringify({ bullets: bullets.map(b => b.replace(/^\w+/, 'Delivered')), added: ['Delivered Java services on Kubernetes for the payments team.'] }) } });
  });
  await new Promise(r => ollama.listen(0, '127.0.0.1', r));
  process.env.OLLAMA_URL = `http://127.0.0.1:${ollama.address().port}`; process.env.OLLAMA_MODEL = 'test-model';
  await cleanup();
  let server;
  try {
    let r = await importTsentaHistory(USER, { dir: FIX });
    check('import: every Tsenta application is added', r.applications === 4 && r.inserted === 4 && r.withDescription === 2 && r.withResume === 1, r);
    r = await importTsentaHistory(USER, { dir: FIX });
    check('import: running it again updates instead of duplicating', r.inserted === 0 && r.updated === 4, r);
    const { rows: imp } = await query(`SELECT status, source, applied_at, job_snapshot FROM applications WHERE user_id = $1 AND external_application_id = 't-0001'`, [USER]);
    check('import: kept as Applied on the original date with the posting text', imp[0].status === 'APPLIED' && imp[0].source === 'tsenta' && imp[0].applied_at.toISOString() === '2026-10-20T15:00:00.000Z' && imp[0].job_snapshot.description.includes('card payments') && imp[0].job_snapshot.salaryMinAnnual === 120000, imp[0]);

    let s = await searchApplied(USER, { q: 'acmepay' });
    check('search: company name finds both AcmePay roles, newest first', s.total === 2 && s.applications[0].title === 'Backend Engineer, Payments' && s.applications.every(a => a.matchedOn.includes('company')), s.applications);
    check('search: counts come back per field', s.counts.company === 2 && s.counts.link === 2 && s.counts.title === 0, s.counts);
    s = await searchApplied(USER, { q: 'Kafka' });
    check('search: posting text matches show a snippet', s.total === 1 && s.applications[0].matchedOn.includes('posting') && s.applications[0].postingSnippet?.match === 'Kafka', s.applications);
    s = await searchApplied(USER, { q: 'acme health' });
    check('search: a link matches with spaces left out', s.applications.some(a => a.company === 'Acme Health' && a.matchedOn.includes('link')), s.applications);
    s = await searchApplied(USER, { q: 'engineer', fields: ['title'] });
    check('search: limited to one field', s.total === 4 && s.counts.company === 0, s.counts);
    s = await searchApplied(USER, { groupBy: 'company' });
    check('search: group by company with role counts', s.companies.find(c => c.company === 'AcmePay')?.roleCount === 2 && s.totalGroups === 3, s.companies);
    check('search: source filter', (await searchApplied(USER, { source: 'app' })).total === 0 && (await searchApplied(USER, { source: 'tsenta' })).total === 4);

    // A rewrite made here is stored as training data, then marked sent and given an outcome.
    const rp = await createResumeProfile(USER, { name: 'Backend' });
    await updateResumeProfile(USER, rp.id, { sections: profile });
    const { rows: [job] } = await query(
      `INSERT INTO jobs (url, title, normalized_title, company, ats, role_family, canonical_role, description_clean, workplace_type, employment_type, status, active, fingerprint, discovered, location)
       VALUES ('https://example.com/rm/1', 'Backend Engineer', 'backend engineer', 'Initech', 'demo', 'SOFTWARE_ENGINEERING', 'BACKEND_ENGINEER',
               'Build Java and Spring Boot services. Docker and Kubernetes. REST APIs with JWT.', 'REMOTE', 'FULL_TIME', 'READY', TRUE, 'rmtest0000000001', NOW(), 'Remote') RETURNING id`);
    const tr = await trackApplication(USER, job.id, 'SAVED');
    const prep = await prepareApplication(USER, tr.id, { mode: 'ai' });
    check('tailoring with the local model works end to end', prep.ok && prep.report.mode === 'ai' && prep.report.model === 'ollama:test-model', prep.report);
    const prepMatch = await prepareApplication(USER, tr.id);
    check('the default tailoring is "match the job", and it adds bullets and skills', prepMatch.ok && prepMatch.report.mode === 'match' && prepMatch.report.addedBullets.length >= 1, prepMatch.report);
    await query(`DELETE FROM resume_rewrites WHERE user_id = $1 AND mode = 'match'`, [USER]);
    let rows = (await listRewritesForExport(USER)).filter(x => x.source === 'app');
    check('every tailoring is stored with the posting, before, after and blocks', rows.length === 1 && rows[0].job_description.includes('Spring Boot') && rows[0].resume_before.experience.length === 2 && rows[0].report.blocks.length >= 2 && !rows[0].sent, rows[0]?.report?.blocks?.length);
    await updateApplication(USER, tr.id, { status: 'APPLIED' });
    await updateApplication(USER, tr.id, { status: 'INTERVIEWING' });
    rows = (await listRewritesForExport(USER)).filter(x => x.source === 'app');
    check('applying marks it sent; later moves record the outcome', rows[0].sent === true && rows[0].outcome === 'INTERVIEWING', rows[0]);
    const st = await rewriteStats(USER);
    check('training-data counts', st.total === 2 && st.from_tsenta === 1 && st.model_rewrites === 1 && st.led_to_interview === 1, st);
    const { examples: ex2, stats: st2 } = buildExamples(await listRewritesForExport(USER), profile, { style: 'honest' });
    check('export builds examples from both sources', st2.fromApp >= 2 && st2.fromTsenta >= 1 && ex2.length === st2.fromApp + st2.fromTsenta, st2);

    // Your own original → tailored example.
    const P0 = withDefaults(profile);
    const mine = JSON.parse(JSON.stringify(P0));
    mine.experience[0].bullets.push('Built Kafka consumers in Java that validated payment events before they reached downstream Spring Boot services.');
    const toText = x => [x.personal?.fullName || 'Alex Rivera', 'EXPERIENCE', ...x.experience.flatMap(e => [`${e.title}`, `${e.company} ${e.startDate || ''} – ${e.endDate || 'Present'}`, ...e.bullets.map(b => `• ${b}`)])].join('\n');
    const bad = await addManualExample(USER, { original: '', tailored: 'x' });
    check('your example: both resumes are required', bad.error && bad.code === 400);
    const me = await addManualExample(USER, { original: P0, tailored: mine, jobTitle: 'Backend Engineer', company: 'Initech', jobDescription: 'Java, Kafka, Spring Boot.' });
    check('your example: saved with bullet counts', me.id && me.bullets.tailored === me.bullets.original + 1 && me.hasPosting, me);
    const meText = await addManualExample(USER, { original: toText(P0), tailored: toText(mine) });
    check('your example: resume text (as read from a PDF) works too', meText.id && meText.bullets.tailored >= 1 && !meText.hasPosting, meText);
    check('your example: listed', (await listManualExamples(USER)).length === 2);
    const bankDb = await loadBulletBank(USER);
    check('bullet bank: includes bullets from your examples', bankDb.roles.some(r => r.bullets.some(b => /Kafka consumers in Java/.test(b))), bankDb.roles.map(r => r.company));
    const prepBank = await prepareApplication(USER, tr.id);
    check('match tailoring reuses a bullet you wrote before when it fits', prepBank.report.addedBullets.some(b => b.from === 'bank' && /Kafka consumers/.test(b.text)), prepBank.report.addedBullets);
    await query(`DELETE FROM resume_rewrites WHERE user_id = $1 AND source = 'manual'`, [USER]);
    await query(`DELETE FROM resume_rewrites WHERE user_id = $1 AND source = 'app' AND mode = 'match'`, [USER]);

    // API
    const PORT = 3995;
    server = spawn(process.execPath, ['api/server.mjs', '--port', String(PORT)], { cwd: ROOT, env: { ...process.env, TSENTA_IMPORT_DIR: FIX }, stdio: ['ignore', 'ignore', 'pipe'] });
    const base = `http://localhost:${PORT}`;
    for (let i = 0; i < 60; i++) { try { await fetch(`${base}/health`); break; } catch { await new Promise(res => setTimeout(res, 100)); } }
    const call = async (method, path) => { const res = await fetch(base + path, { method }); return { status: res.status, body: await res.json().catch(() => null) }; };
    let a = await call('GET', `/users/${USER}/applied?q=acmepay&fields=company,title`);
    check('API: /applied searches', a.status === 200 && a.body.total === 2 && a.body.counts.link === 0, a.body?.counts);
    a = await call('GET', `/users/${USER}/applied?groupBy=company`);
    check('API: /applied groups by company', a.body.companies?.length === 4, a.body.companies?.map(c => c.company));
    a = await call('GET', `/users/${USER}/imports/tsenta`);
    check('API: import status', a.body.available?.applications === 4 && a.body.imported === 4, a.body);
    a = await call('POST', `/users/${USER}/imports/tsenta`);
    check('API: import runs', a.status === 200 && a.body.updated === 4, a.body);
    a = await call('GET', `/users/${USER}/resume-model`);
    check('API: model status and training-data counts', a.body.ok === true && a.body.model === 'test-model' && a.body.trainingData.total === 2, a.body);
    const { rows: [ts] } = await query(`SELECT id FROM applications WHERE user_id = $1 AND external_application_id = 't-0001'`, [USER]);
    a = await call('GET', `/users/${USER}/applications/${ts.id}`);
    check('API: a Tsenta application shows the posting, the resume sent and what it claimed', a.body.snapshot.description.includes('card payments') && a.body.tailoredResume.sections.experience.length === 2
      && a.body.claimsCheck.unsupported.map(x => x.toLowerCase()).includes('terraform'), a.body.claimsCheck);
    a = await call('GET', `/users/${USER}/applications/${tr.id}/changes`);
    check('API: what tailoring changed, with originals for reworded bullets', a.status === 200 && a.body.counts && a.body.changes.some(c => c.type === 'edited' && c.original), a.body?.counts);
    const chg = await fetch(`${base}/users/${USER}/applications/${tr.id}/resume?changes=1`).then(r => r.text());
    check('API: the resume page with changes highlighted', chg.includes('What changed for this job') && chg.includes('data-orig='));
    const post = await fetch(`${base}/users/${USER}/resume-examples`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ original: P0, tailored: mine, jobTitle: 'Backend Engineer' }) });
    const pj = await post.json();
    check('API: add your own example', post.status === 201 && pj.id, pj);
    a = await call('GET', `/users/${USER}/resume-examples`);
    check('API: list your examples', a.body.examples?.length === 1 && a.body.examples[0].jobTitle === 'Backend Engineer', a.body);
    a = await call('DELETE', `/users/${USER}/resume-examples/${pj.id}`);
    check('API: remove one', a.body.deleted === true && (await call('GET', `/users/${USER}/resume-examples`)).body.examples.length === 0);
    const res = await fetch(`${base}/users/${USER}/applications/${ts.id}/resume`);
    const html = await res.text();
    check('API: the resume Tsenta sent renders as a page', res.status === 200 && html.includes('Alex Rivera') && html.includes('JWT-authenticated'));
  } finally {
    server?.kill();
    ollama.close();
    await cleanup();
    await closePool();
  }
}
