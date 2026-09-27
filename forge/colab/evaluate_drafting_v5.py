"""Verify the downloaded v5 export, then evaluate the frozen 59 Go tasks."""
import argparse
import hashlib
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
EXPECTED = {
    "json": "914a4411bbe34c78d606531ca8475e28ee92b3712464371960ac0a4f76fa2876",
    "safetensors": "1a275f6a5541da2cc942d25c6bd7530fcfbb74c17c501cf0e49a1efbca4e8446",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adapter", default=str(Path.home() / "Downloads/ilaria-drafting-v5"))
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()
    for suffix, expected in EXPECTED.items():
        path = Path(args.adapter + "." + suffix)
        if not path.is_file():
            raise SystemExit(f"Missing export: {path}")
        with path.open("rb") as handle:
            actual = hashlib.file_digest(handle, "sha256").hexdigest()
        if actual != expected:
            raise SystemExit(f"SHA256 mismatch: {path}; refusing evaluation")
        print(f"Verified {path.name}: {actual}", flush=True)
    if args.check_only:
        return
    results = ROOT / "results/ilaria-grounding-v3"
    stdout = results / "final.txt"
    stderr = results / "final-transcripts.txt"
    if stdout.exists() or stderr.exists():
        raise SystemExit("Final output already exists; inspect it before another run.")
    command = [
        "go", "run", "-tags", "gpu", "./cmd/ilaria-chat", "-cuda",
        "-model", "data/forge/bitnet-2b4t/bitnet.nxtf",
        "-tokenizer", "data/pretrained/bitnet-b1.58-2B-4T/tokenizer.json",
        "-adapter", args.adapter,
        "-eval", str(results / "final-tasks.jsonl"),
        "-max-tokens", "128", "-max-calls", "3", "-show-transcript",
    ]
    with stdout.open("x", encoding="utf-8") as out, stderr.open("x", encoding="utf-8") as err:
        subprocess.run(command, cwd=ROOT, stdout=out, stderr=err, check=True)
    subprocess.run([sys.executable, "forge/colab/extract_grounding_eval.py"], cwd=ROOT, check=True)
    print("Evaluation captured. Review all 59 answers manually; substring accuracy is insufficient.")


if __name__ == "__main__":
    main()
