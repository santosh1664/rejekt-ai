/**
 * LLM fallback for job application form questions (autoapply).
 *
 * When answers.mjs cannot classify a form field — custom essay prompts,
 * "Why do you want to work here?", behavioural questions, etc. — this module
 * calls the configured cloud LLM (OpenRouter / Anthropic / HuggingFace) to
 * generate an honest, resume-grounded answer.
 *
 * Intentionally skips Ollama: local models are too slow for interactive form
 * filling and the form filler must not block for minutes on a single field.
 *
 * Uses the same LLM_PROVIDER / API key as resume tailoring (lib/llm.mjs), so
 * no extra key is needed when OpenRouter is already configured.
 */
import { llmConfig, OPENROUTER_PRIVACY } from '../lib/llm.mjs';

const SYSTEM = `You are filling out a job application on behalf of the candidate.
Answer each question honestly and concisely using ONLY information from the resume and job provided.
Never fabricate experience, credentials, or achievements not present in the resume.
Write in first person. Be direct, professional, and specific.
Do not use filler phrases like "I am passionate about" or "I am excited to".`;

function resumeToText(sections = {}) {
  const lines = [];
  const p = sections.personal || {};
  if (p.fullName) lines.push(`Candidate: ${p.fullName}`);
  if (p.city || p.state) lines.push(`Location: ${[p.city, p.state].filter(Boolean).join(', ')}`);
  for (const exp of (sections.experience || [])) {
    const dates = [exp.startDate, exp.current ? 'Present' : exp.endDate].filter(Boolean).join('–');
    lines.push(`\nRole: ${exp.title} at ${exp.company}${dates ? ` (${dates})` : ''}`);
    for (const b of (exp.bullets || [])) lines.push(`  • ${b}`);
  }
  for (const edu of (sections.education || [])) {
    const yr = (edu.endDate || '').slice(0, 4);
    lines.push(`\nEducation: ${[edu.degree, edu.field ? `in ${edu.field}` : '', `from ${edu.school || ''}`, yr ? `(${yr})` : ''].filter(Boolean).join(' ')}`);
  }
  const skills = (sections.skills || []).map(s => (typeof s === 'string' ? s : s.name)).filter(Boolean);
  if (skills.length) lines.push(`\nSkills: ${skills.join(', ')}`);
  for (const proj of (sections.projects || [])) {
    lines.push(`\nProject: ${proj.name}${proj.summary ? ' — ' + proj.summary : ''}`);
    for (const b of (proj.bullets || [])) lines.push(`  • ${b}`);
  }
  const saved = (sections.savedAnswers || []).slice(0, 10);
  if (saved.length) {
    lines.push('\nPreviously answered:');
    for (const sa of saved) lines.push(`  Q: ${sa.question}\n  A: ${sa.answer}`);
  }
  return lines.join('\n').trim();
}

function getCloudCfg() {
  const cfg = llmConfig();
  if (!['openrouter', 'huggingface', 'anthropic'].includes(cfg.provider)) return null;
  if (!cfg.apiKey) return null;
  return cfg;
}

async function callText(cfg, system, userPrompt, maxTokens = 300) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25_000);
  try {
    if (cfg.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, temperature: 0.3, system, messages: [{ role: 'user', content: userPrompt }] }),
      });
      if (!res.ok) return null;
      const d = await res.json();
      return (d.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim() || null;
    }
    const url = cfg.provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : 'https://router.huggingface.co/v1/chat/completions';
    const res = await fetch(url, {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, temperature: 0.3, messages: [{ role: 'system', content: system }, { role: 'user', content: userPrompt }],
        ...(cfg.provider === 'openrouter' ? OPENROUTER_PRIVACY : {}) }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return d.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

export async function llmAnswer(question, { job = {}, resumeSections = {}, maxWords = 120 } = {}) {
  const cfg = getCloudCfg();
  if (!cfg) return null;
  const resumeText = resumeToText(resumeSections);
  const jobText = [
    job.title && `Job title: ${job.title}`,
    job.company && `Company: ${job.company}`,
    job.description && `Job description excerpt:\n${job.description.slice(0, 1000)}`,
  ].filter(Boolean).join('\n');
  const prompt = `RESUME:\n${resumeText}\n\nJOB:\n${jobText}\n\nFORM QUESTION: ${question}\n\nWrite an answer in ${maxWords} words or fewer. Output ONLY the answer text.`;
  return callText(cfg, SYSTEM, prompt);
}

export async function llmChoose(question, options, { job = {}, resumeSections = {} } = {}) {
  const cfg = getCloudCfg();
  if (!cfg || !options?.length) return null;
  const resumeText = resumeToText(resumeSections);
  const jobText = job.title ? `Job: ${job.title} at ${job.company || ''}` : '';
  const optList = options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
  const prompt = `RESUME:\n${resumeText}\n\n${jobText}\n\nQUESTION: ${question}\n\nOPTIONS:\n${optList}\n\nReply with ONLY the option number that best applies to the candidate.`;
  const text = await callText(cfg, SYSTEM, prompt, 20);
  if (!text) return null;
  const num = parseInt(text.trim(), 10);
  if (Number.isFinite(num) && num >= 1 && num <= options.length) return options[num - 1].label;
  const lower = text.toLowerCase();
  return options.find(o => lower.includes(o.label.toLowerCase()))?.label || null;
}
