#!/usr/bin/env bash
# Fine-tune Qwen2.5 on your best resume rewrites (Mac with Apple silicon) and
# load it into Ollama as "jd-rewriter". See docs/resume-model.md.
#
#   npm run ml:rewriter:generate -- --user <your user id>   # 1. best-of-N data (overnight)
#   npm run ml:rewriter:export -- --style bon               # 2. training files from versions scoring 9+
#   npm run ml:rewriter:train                               # 3. this script: train + install
#   npm run ml:rewriter:eval-ats                            # 4. base model vs yours, on postings it never saw
#   then set OLLAMA_MODEL=jd-rewriter in .env.local         # 5. use it
#
# Settings (environment variables):
#   BASE_MODEL  MLX model to start from (default mlx-community/Qwen2.5-7B-Instruct-4bit,
#               the same Qwen 2.5 7B you run in Ollama). On 8 GB Macs use
#               mlx-community/Qwen2.5-3B-Instruct-4bit and BASE_OLLAMA=qwen2.5:3b-instruct.
#   BASE_OLLAMA Ollama model whose chat template is copied (default qwen2.5:7b-instruct)
#   ITERS       training steps (default: about 2 passes over the data, 200–1500)
#   LAYERS      layers that get LoRA adapters (default 8; 16 if you have 32 GB+)
#   DATA        folder with train.jsonl / valid.jsonl (default ml/data/rewriter)
#   NAME        Ollama model name (default jd-rewriter)
#   KEEP_FUSED  1 keeps the 15 GB merged weights after import (default: deleted)
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_MODEL="${BASE_MODEL:-mlx-community/Qwen2.5-7B-Instruct-4bit}"
BASE_OLLAMA="${BASE_OLLAMA:-qwen2.5:7b-instruct}"
DATA="${DATA:-ml/data/rewriter}"
NAME="${NAME:-jd-rewriter}"
LAYERS="${LAYERS:-8}"
OUT="ml/out/${NAME}"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This script uses MLX, which needs a Mac with Apple silicon. On Linux with an NVIDIA GPU, train a LoRA on Qwen/Qwen2.5-7B-Instruct with the same train.jsonl/valid.jsonl using any chat fine-tuning tool, merge it, and import the merged safetensors with an Ollama Modelfile (FROM <folder>)." >&2
  exit 1
fi
for f in train.jsonl valid.jsonl; do
  [[ -s "$DATA/$f" ]] || { echo "Missing $DATA/$f. Run: npm run ml:rewriter:export -- --style bon" >&2; exit 1; }
done
TRAIN_N=$(wc -l < "$DATA/train.jsonl" | tr -d ' ')
if (( TRAIN_N < 150 )); then
  echo "Only $TRAIN_N training examples. Below ~150 the model mostly memorizes; generate more first (npm run ml:rewriter:generate -- --limit 200)." >&2
  read -r -p "Train anyway? [y/N] " ok; [[ "$ok" == "y" || "$ok" == "Y" ]] || exit 1
fi
ITERS="${ITERS:-$(( TRAIN_N * 2 < 200 ? 200 : (TRAIN_N * 2 > 1500 ? 1500 : TRAIN_N * 2) ))}"
command -v ollama >/dev/null || { echo "Install Ollama first: brew install ollama" >&2; exit 1; }
ollama show "$BASE_OLLAMA" >/dev/null 2>&1 || { echo "Pull the base model first: ollama pull $BASE_OLLAMA" >&2; exit 1; }
FREE_GB=$(df -g . | awk 'NR==2 {print $4}')
if (( FREE_GB < 25 )); then
  echo "About 25 GB of free disk is needed (merged weights before Ollama compresses them); $FREE_GB GB free." >&2
  exit 1
fi

python3 -m venv ml/.venv
# shellcheck disable=SC1091
source ml/.venv/bin/activate
pip install --quiet --upgrade "mlx-lm>=0.20"

mkdir -p "$OUT"
echo "▶ Training LoRA on $BASE_MODEL ($TRAIN_N examples, $ITERS steps, $LAYERS layers)"
echo "  Close other heavy apps; with 16 GB this uses most of the memory. Stop Ollama while training: brew services stop ollama (or quit it)."
mlx_lm.lora --model "$BASE_MODEL" --train --data "$DATA" \
  --iters "$ITERS" --batch-size 1 --num-layers "$LAYERS" --learning-rate 1e-5 --mask-prompt \
  --grad-checkpoint --max-seq-length 3072 \
  --steps-per-eval 100 --save-every 100 \
  --adapter-path "$OUT/adapter"

if [[ -s "$DATA/test.jsonl" ]]; then
  echo "▶ Test-set loss"
  mlx_lm.lora --model "$BASE_MODEL" --adapter-path "$OUT/adapter" --data "$DATA" --test --max-seq-length 3072 || true
fi

echo "▶ Merging the adapter into full weights"
rm -rf "$OUT/fused"
mlx_lm.fuse --model "$BASE_MODEL" --adapter-path "$OUT/adapter" --save-path "$OUT/fused" --dequantize

# Same chat template and stop tokens as the Qwen model you already run.
ollama show "$BASE_OLLAMA" --modelfile | node -e '
  let s = require("fs").readFileSync(0, "utf8");
  s = s.replace(/^LICENSE\s+"""[\s\S]*?"""\s*$/gm, "").replace(/^LICENSE .*$/gm, "").replace(/^FROM .*$/gm, "").replace(/^#.*$/gm, "");
  s = s.replace(/^PARAMETER (temperature|num_ctx) .*$/gm, "");
  process.stdout.write("FROM ./fused\n" + s.trim() + "\nPARAMETER temperature 0.4\nPARAMETER num_ctx 8192\n");
' > "$OUT/Modelfile"

# Ollama can't import fine-tuned Qwen2 safetensors directly; convert through GGUF.
NAME="$NAME" bash ml/install-rewriter.sh

echo
echo "Done. Compare it with the base model on postings it never saw:"
echo "  npm run ml:rewriter:eval-ats"
echo "If $NAME scores higher, add OLLAMA_MODEL=$NAME to .env.local and restart the app."
