#!/bin/bash
# Tokenize the corpus on the VM's local disk (the Drive FUSE mount cannot serve
# many parallel readers), then copy the single training stream back to Drive.
# Colab: upload to MyDrive/ilaria/ and run  !bash /content/drive/MyDrive/ilaria/tokenize_local.sh
# Measured 2026-09-21 on the Colab GPU runtime (RTX PRO 6000 Blackwell, 48 vCPU): 116 shards, 3.72 G tokens in ~8 min.
set -u
D=/content/drive/MyDrive/ilaria
L=/content/ilaria
cd /content/nexus || exit 1
mkdir -p "$L/corpus"
N=$(nproc); echo "cpus=$N"; df -h /content | tail -1
# 1. tokenizer + JSONL shards -> local disk (sequential copies are gentle on Drive)
[ -s "$L/tokenizer.json" ] || cp "$D/tokenizer.json" "$L/tokenizer.json" || { echo "tokenizer copy failed"; exit 1; }
[ -s "$L/tokenizer.hf.json" ] || cp "$D/tokenizer.hf.json" "$L/tokenizer.hf.json" || true
ls -la "$L/tokenizer.json"
i=0
for f in "$D"/corpus/*.jsonl; do
  b=$(basename "$f"); i=$((i+1))
  [ -s "$L/corpus/$b" ] || cp "$f" "$L/corpus/$b" || { echo "copy failed: $b"; exit 1; }
  [ $((i % 10)) -eq 0 ] && echo "  copied $i shards ($(date +%H:%M:%S))"
done
echo "local shards: $(ls "$L"/corpus/*.jsonl | wc -l)"; du -sh "$L/corpus"
# 2. tokenize locally on all cores; extra passes catch stragglers
for pass in 1 2 3; do
  todo=$(for f in "$L"/corpus/*.jsonl; do p="${f%.jsonl}"; [ -s "$p.json" ] || echo "$p"; done)
  [ -z "$todo" ] && break
  echo "pass $pass: $(echo "$todo" | wc -l) shards to tokenize ($(date +%H:%M:%S))"
  echo "$todo" | xargs -P "$N" -I{} python forge/hf_tokenizer.py encode --tokenizer "$L/tokenizer.json" --in {}.jsonl --out {}
done
missing=$(for f in "$L"/corpus/*.jsonl; do p="${f%.jsonl}"; [ -s "$p.json" ] || echo "$p"; done | wc -l)
[ "$missing" -eq 0 ] || { echo "still missing $missing shards"; exit 1; }
# 3. one interleaved stream (local), then copy it to Drive
python forge/concat_streams.py --out "$L/train_stream" \
  --prefix "ro=$L/corpus/fineweb2_ro" --prefix "ro=$L/corpus/wiki_ro" \
  --prefix "en=$L/corpus/fineweb_edu" --prefix "en=$L/corpus/wiki_en" || exit 1
cat "$L/train_stream.json"; echo
cp "$L/train_stream.json" "$D/train_stream.json" && cp "$L/train_stream.bin" "$D/train_stream.bin" && echo "stream copied to Drive ($(date +%H:%M:%S))"
ls -la "$D/train_stream.bin" "$D/train_stream.json"
