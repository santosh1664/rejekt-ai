#!/usr/bin/env bash
# Install the fine-tuned rewriter (ml/out/<NAME>/fused) into Ollama.
#
#   bash ml/install-rewriter.sh
#
# Newer Ollama versions can't import fine-tuned Qwen2 safetensors directly
# ("unsupported MLX architecture: Qwen2ForCausalLM"), so the merged weights are
# converted to GGUF with llama.cpp, compressed to Q4_K_M (~4.7 GB, the same
# compression as Ollama's own qwen2.5:7b-instruct), and imported from that.
# Needs internet the first time (llama.cpp and its Python packages).
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="${NAME:-jd-rewriter}"
OUT="ml/out/${NAME}"
QUANT="${QUANT:-Q4_K_M}"
LLAMA="ml/.llama.cpp"

[[ -f "$OUT/fused/config.json" ]] || { echo "No merged model at $OUT/fused. Run npm run ml:rewriter:train first." >&2; exit 1; }
[[ -f "$OUT/Modelfile" ]] || { echo "No $OUT/Modelfile. Run npm run ml:rewriter:train first." >&2; exit 1; }

command -v llama-quantize >/dev/null || { echo "▶ Installing llama.cpp (brew)"; brew install llama.cpp; }
if [[ ! -f "$LLAMA/convert_hf_to_gguf.py" ]]; then
  echo "▶ Downloading the llama.cpp converter"
  rm -rf "$LLAMA"; git clone --depth 1 https://github.com/ggml-org/llama.cpp "$LLAMA"
fi
[[ -d ml/.venv ]] || python3 -m venv ml/.venv
# shellcheck disable=SC1091
source ml/.venv/bin/activate
pip install --quiet --upgrade -r "$LLAMA/requirements/requirements-convert_hf_to_gguf.txt"

GGUF16="$OUT/${NAME}-f16.gguf"
GGUFQ="$OUT/${NAME}-$(echo "$QUANT" | tr '[:upper:]' '[:lower:]').gguf"
# mlx-lm writes extra_special_tokens as a list (newer transformers format); the
# converter's transformers expects the older additional_special_tokens.
python3 - "$OUT/fused/tokenizer_config.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); x = d.pop("extra_special_tokens", None)
if isinstance(x, list): d.setdefault("additional_special_tokens", x)
elif x is not None: d["extra_special_tokens"] = x
json.dump(d, open(p, "w"), indent=2)
PY
echo "▶ Converting to GGUF (about 15 GB, a few minutes)"
python "$LLAMA/convert_hf_to_gguf.py" "$OUT/fused" --outtype f16 --outfile "$GGUF16"
echo "▶ Compressing to $QUANT"
llama-quantize "$GGUF16" "$GGUFQ" "$QUANT"
rm -f "$GGUF16"

# Same Modelfile (chat template, stop tokens), pointing at the GGUF file.
sed "s#^FROM .*#FROM ./$(basename "$GGUFQ")#" "$OUT/Modelfile" > "$OUT/Modelfile.gguf"
curl -s -m 2 http://localhost:11434/api/tags >/dev/null || { ollama serve >/dev/null 2>&1 & sleep 3; }
echo "▶ Installing into Ollama as $NAME"
(cd "$OUT" && ollama create "$NAME" -f Modelfile.gguf)
ollama list | grep -q "^$NAME" && echo "Installed: $NAME" || { echo "ollama create did not register $NAME" >&2; exit 1; }
[[ "${KEEP_FUSED:-0}" == "1" ]] || { rm -rf "$OUT/fused"; echo "Deleted the 15 GB merged weights (Ollama has its own copy). Set KEEP_FUSED=1 to keep them."; }
