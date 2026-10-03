from pathlib import Path
import os
import subprocess
import sys

from cases import (
    assert_rejected_and_restored,
    eval_improves_anchor_regresses_case,
    load_canonical_peer,
    sign_inverted_case,
)


def _canonical_root():
    value = os.environ.get("ILARIA_CANONICAL_ROOT")
    if not value:
        raise RuntimeError("set ILARIA_CANONICAL_ROOT to the canonical public source checkout")
    return Path(value)


def test_sign_inverted_real_backprop_delta_is_rejected_and_restored():
    peer, _ = load_canonical_peer(_canonical_root())
    result = sign_inverted_case(peer)
    assert result["candidate"]["objective"] > result["before"]["objective"]
    assert not result["accepted"]
    assert result["checkpoint"] is None
    assert result["active"] == result["before"]


def test_eval_improvement_with_anchor_regression_is_rejected_and_restored():
    peer, _ = load_canonical_peer(_canonical_root())
    result = eval_improves_anchor_regresses_case(peer)
    assert_rejected_and_restored(result, require_anchor_drop=True)


def test_runner_refuses_to_replace_existing_receipt(tmp_path):
    output = tmp_path / "receipt.json"
    sentinel = "preserve existing evidence\n"
    output.write_text(sentinel, encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(Path(__file__).with_name("run.py")),
         "--canonical-root", str(_canonical_root()), "--output", str(output)],
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode != 0
    assert "refusing to overwrite existing receipt" in result.stderr
    assert output.read_text(encoding="utf-8") == sentinel
