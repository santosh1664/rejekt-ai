#!/usr/bin/env bash
# Install the Rejekt.ai resume-rewriting model (jd-rewriter-v2) into Ollama.
#
#   bash scripts/install-model.sh                 # download from the GitHub release, then register
#   bash scripts/install-model.sh /path/to/folder # folder that already holds the downloaded parts or the .gguf
#
# The model is a LoRA fine-tune of Qwen2.5-7B-Instruct (Q4_K_M, 4.7 GB). GitHub caps release files at
# 2 GB, so it is published as three parts that this script downloads, joins and checks.
#
# Settings: REPO (default santosh1664/rejekt-ai)  TAG (default model-v2)  NAME (default jd-rewriter-v2)
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${REPO:-santosh1664/rejekt-ai}"
TAG="${TAG:-model-v2}"
NAME="${NAME:-jd-rewriter-v2}"
GGUF="${NAME}-q4_k_m.gguf"
DIR="${1:-ml/model/download}"

command -v ollama >/dev/null || { echo "Install Ollama first: https://ollama.com (brew install ollama)" >&2; exit 1; }
mkdir -p "$DIR"

if [[ ! -f "$DIR/$GGUF" ]]; then
  if ! ls "$DIR/$GGUF".part-* >/dev/null 2>&1; then
    echo "▶ Downloading $GGUF from github.com/$REPO (release $TAG), about 4.7 GB"
    if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
      gh release download "$TAG" --repo "$REPO" --dir "$DIR" --pattern "$GGUF.part-*" --pattern "$GGUF.sha256" --clobber
    else
      for p in aa ab ac; do
        curl -fL --retry 3 -C - -o "$DIR/$GGUF.part-$p" "https://github.com/$REPO/releases/download/$TAG/$GGUF.part-$p"
      done
      curl -fL -o "$DIR/$GGUF.sha256" "https://github.com/$REPO/releases/download/$TAG/$GGUF.sha256" || true
    fi
  fi
  echo "▶ Joining the parts"
  cat "$DIR/$GGUF".part-* > "$DIR/$GGUF"
  if [[ -f "$DIR/$GGUF.sha256" ]]; then
    want="$(awk '{print $1}' "$DIR/$GGUF.sha256")"
    got="$(shasum -a 256 "$DIR/$GGUF" | awk '{print $1}')"
    [[ "$want" == "$got" ]] || { echo "Checksum mismatch: the download is damaged. Delete $DIR and run again." >&2; exit 1; }
    echo "✓ Checksum OK"
  fi
  rm -f "$DIR/$GGUF".part-*
fi

echo "▶ Registering $NAME with Ollama"
cp "ml/model/Modelfile.$NAME" "$DIR/Modelfile"
( cd "$DIR" && ollama create "$NAME" -f Modelfile )
echo "✓ Done. Set OLLAMA_MODEL=$NAME in .env.local, then run: npm start"
