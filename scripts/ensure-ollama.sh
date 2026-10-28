#!/bin/bash
# Run by `npm start` (prestart): make sure Ollama is serving so resume bullets get rewritten.
URL="${OLLAMA_HOST_URL:-http://localhost:11434}"
up() { curl -sf -m 2 "$URL/api/tags"; }
if ! up >/dev/null; then
  command -v ollama >/dev/null || { echo "ollama not installed (ollama.com); bullets won't be rewritten" >&2; exit 0; }
  mkdir -p logs
  nohup ollama serve >> logs/ollama.log 2>&1 &
  for _ in $(seq 20); do up >/dev/null && break; sleep 1; done
fi
up | grep -q "${OLLAMA_MODEL:-jd-rewriter}" || echo "ollama is up but the model is missing: run scripts/install-model.sh (or: ollama pull qwen2.5:7b-instruct)" >&2
exit 0  # never block the web server from starting
