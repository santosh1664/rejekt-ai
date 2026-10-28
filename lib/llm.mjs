/**
 * Language-model access for resume rewriting (docs/resume-model.md).
 *
 * The default is a local model served by Ollama on this machine (free and
 * private: the resume and job description never leave the computer). Claude
 * can be used instead by setting LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY.
 *
 *   LLM_PROVIDER   ollama (default) | anthropic | openrouter | huggingface
 *   OPENROUTER_API_KEY / OPENROUTER_MODEL   (e.g. qwen/qwen-2.5-72b-instruct)
 *   HF_TOKEN / HF_MODEL                     (Hugging Face router, e.g. Qwen/Qwen2.5-72B-Instruct)
 *   OLLAMA_URL     http://localhost:11434
 *   OLLAMA_MODEL   qwen2.5:7b-instruct  (or your fine-tuned model, e.g. jd-rewriter)
 *   ANTHROPIC_MODEL
 */

export const DEFAULT_OLLAMA_MODEL = 'qwen2.5:7b-instruct';

// OpenAI-compatible hosts: both speak /chat/completions.
const OPENAI_HOSTS = {
  openrouter:  { url: 'https://openrouter.ai/api/v1',       key: 'OPENROUTER_API_KEY', model: 'OPENROUTER_MODEL', fallback: 'qwen/qwen-2.5-72b-instruct' },
  huggingface: { url: 'https://router.huggingface.co/v1',   key: 'HF_TOKEN',           model: 'HF_MODEL',         fallback: 'Qwen/Qwen2.5-72B-Instruct' },
};

export function llmConfig(env = process.env) {
  const provider = (env.LLM_PROVIDER || 'ollama').toLowerCase();
  const host = OPENAI_HOSTS[provider];
  if (host) return { provider, model: env[host.model] || host.fallback, apiKey: env[host.key] || null, keyName: host.key, url: host.url };
  if (provider === 'anthropic') {
    return { provider, model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', apiKey: env.ANTHROPIC_API_KEY || null };
  }
  return { provider: 'ollama', model: env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL, url: (env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '') };
}

/**
 * Is the model reachable? { ok, provider, model, reason?, installed? }
 * For Ollama this also says whether the model has been pulled.
 */
export async function llmStatus({ fetchImpl = fetch, env = process.env, timeoutMs = 2500 } = {}) {
  const cfg = llmConfig(env);
  if (cfg.keyName) {
    return cfg.apiKey ? { ok: true, provider: cfg.provider, model: cfg.model } : { ok: false, provider: cfg.provider, model: cfg.model, reason: `${cfg.keyName} is not set` };
  }
  if (cfg.provider === 'anthropic') {
    return cfg.apiKey ? { ok: true, provider: cfg.provider, model: cfg.model } : { ok: false, provider: cfg.provider, model: cfg.model, reason: 'ANTHROPIC_API_KEY is not set' };
  }
  try {
    const res = await fetchImpl(`${cfg.url}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, provider: 'ollama', model: cfg.model, reason: `Ollama answered ${res.status}` };
    const data = await res.json();
    const names = (data.models || []).map(m => m.name || m.model);
    const installed = names.some(n => n === cfg.model || n === `${cfg.model}:latest` || n.split(':')[0] === cfg.model);
    return installed
      ? { ok: true, provider: 'ollama', model: cfg.model, installed: true }
      : { ok: false, provider: 'ollama', model: cfg.model, installed: false, reason: `Model not pulled yet: run "ollama pull ${cfg.model}"`, available: names };
  } catch (err) {
    return { ok: false, provider: 'ollama', model: cfg.model, reason: `Ollama isn't running at ${cfg.url} (install it from ollama.com, then "ollama pull ${cfg.model}")` };
  }
}

/** Pull the first JSON object out of a model reply. */
export function parseJsonReply(text) {
  const s = String(text || '');
  const start = s.indexOf('{'); const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON');
  return JSON.parse(s.slice(start, end + 1));
}

/**
 * One completion that must come back as JSON.
 * { system, prompt } → parsed object. Throws with a readable reason.
 */
export async function completeJSON({ system, prompt, maxTokens = 3000, temperature = 0.2 }, { fetchImpl = fetch, env = process.env, timeoutMs = 180_000 } = {}) {
  const cfg = llmConfig(env);
  if (cfg.keyName) {
    if (!cfg.apiKey) throw new Error(`${cfg.keyName} is not set`);
    const res = await fetchImpl(`${cfg.url}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, temperature, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`${cfg.provider} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const data = await res.json();
    return { json: parseJsonReply(data.choices?.[0]?.message?.content), provider: cfg.provider, model: cfg.model };
  }
  if (cfg.provider === 'anthropic') {
    if (!cfg.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, temperature, system, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Claude API ${res.status}`);
    const data = await res.json();
    return { json: parseJsonReply((data.content || []).filter(c => c.type === 'text').map(c => c.text).join('')), provider: cfg.provider, model: cfg.model };
  }
  let res;
  try {
    res = await fetchImpl(`${cfg.url}/api/chat`, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model, stream: false, format: 'json',
        options: { temperature, num_predict: maxTokens, num_ctx: 8192 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      }),
    });
  } catch (err) {
    throw new Error(`Ollama isn't reachable at ${cfg.url}: ${err.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(/not found/i.test(body) ? `Model "${cfg.model}" isn't pulled: run "ollama pull ${cfg.model}"` : `Ollama ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return { json: parseJsonReply(data.message?.content), provider: 'ollama', model: cfg.model };
}
