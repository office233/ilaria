"""DiLoCo over a shared folder (Google Drive): several Colab sessions train one LoRA.

Every worker trains the shared adapter for H inner steps on its own
deterministic shard, uploads the result, and one merge step (worker 0)
averages the workers and applies the outer optimizer (Nesterov momentum on the
"outer gradient" global - mean(workers), as in DiLoCo, Douillard et al. 2023).
All workers continue from the new shared version.

Folder layout (everything written once, never replaced):
  run.json                              frozen run contract (data hashes, H, workers, ...)
  round-0003/global.{safetensors,json}  shared adapter for round 3 (trainer export format)
  round-0003/global.manifest.json       sha256 of both files + validation loss; written LAST
  round-0003/worker-1.{safetensors,json}
  round-0003/worker-1.done.json         sha256 + train metadata; written LAST
  round-0003/merge.json                 which workers were used/rejected and why
  outer-state/round-0003.safetensors    outer momentum after producing round 4

Safety rules (fail closed):
  * every file read is checked against the sha256 recorded when it was written;
  * worker adapters with non-finite values or an outlier update norm are dropped;
  * a merged candidate whose validation loss regresses beyond --max-regression is
    retried with half the outer learning rate, then plain averaging; if all
    regress, the previous global is carried forward and momentum is reset.

LoRA note: A and B are averaged separately. mean(B_i) @ mean(A_i) is not
mean(B_i @ A_i); with a shared starting point and short inner phases the gap
is second order, and the validation gate above catches the case where it is not.

Honest cost: N sessions give roughly N times the tokens per wall-clock hour
minus sync/merge overhead (about 2-2.5x on 3 sessions), and each session
spends its own Colab compute units.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCHEMA = 1


# ── files, hashes, atomic writes ──

def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def write_once(path: Path, data: bytes) -> str:
    """Write via a temporary name and rename; refuse to replace an existing file."""
    path = Path(path)
    if path.exists():
        raise FileExistsError(f"{path} already exists; round files are write-once")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp-{os.getpid()}")
    tmp.write_bytes(data)
    os.replace(tmp, path)
    return hashlib.sha256(data).hexdigest()


def write_json_once(path: Path, value) -> str:
    return write_once(path, (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n").encode())


def read_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def round_dir(root: Path, r: int) -> Path:
    return Path(root) / f"round-{r:04d}"


def wait_for(path: Path, timeout: float, poll: float, what: str) -> None:
    deadline = time.monotonic() + timeout
    while not Path(path).exists():
        if time.monotonic() > deadline:
            raise TimeoutError(f"timed out after {timeout:.0f}s waiting for {what}: {path}")
        time.sleep(poll)


# ── adapters as flat tensor dicts ──

def load_adapter(prefix: Path, manifest: dict | None = None) -> tuple[dict, dict]:
    from safetensors.torch import load_file
    weights, meta = Path(str(prefix) + ".safetensors"), Path(str(prefix) + ".json")
    if manifest is not None:
        for path, key in ((weights, "safetensors_sha256"), (meta, "json_sha256")):
            if sha256_file(path) != manifest[key]:
                raise ValueError(f"sha256 mismatch for {path}")
    return load_file(str(weights), device="cpu"), read_json(meta)


def save_adapter(prefix: Path, tensors: dict, meta: dict) -> dict:
    from safetensors.torch import save as save_bytes
    blob = save_bytes({k: v.contiguous() for k, v in sorted(tensors.items())})
    return {"safetensors_sha256": write_once(Path(str(prefix) + ".safetensors"), blob),
            "json_sha256": write_json_once(Path(str(prefix) + ".json"), meta)}


def check_finite(tensors: dict) -> None:
    import torch
    for k, v in tensors.items():
        if not torch.isfinite(v).all():
            raise ValueError(f"non-finite values in {k}")


def delta_norm(a: dict, b: dict) -> float:
    return math.sqrt(sum(float(((a[k].float() - b[k].float()) ** 2).sum()) for k in a))


def outer_step(global_t: dict, workers: list[dict], momentum: dict | None, lr: float, mu: float):
    """Nesterov outer step. Returns (new_global, new_momentum). lr=1, mu=0 is plain averaging."""
    new_g, new_m = {}, {}
    for k, g in global_t.items():
        mean = sum(w[k].float() for w in workers) / len(workers)
        grad = g.float() - mean
        m = grad if momentum is None else mu * momentum[k] + grad
        new_m[k] = m
        new_g[k] = (g.float() - lr * (grad + mu * m)).to(g.dtype)
    return new_g, new_m


# ── deterministic shards ──

def row_key(row: dict) -> str:
    return hashlib.sha256(json.dumps(row["messages"], sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def shard_rows(rows: list[dict], workers: int, worker: int, seed: int) -> list[dict]:
    """Stable assignment by content hash, stable order by a seeded hash: independent of file order."""
    mine = [r for r in rows if int(row_key(r), 16) % workers == worker]
    return sorted(mine, key=lambda r: hashlib.sha256(f"{seed}:{row_key(r)}".encode()).hexdigest())


def round_slice(shard: list[dict], r: int, per_round: int) -> list[dict]:
    """The per_round rows of round r, wrapping around the shard (consecutive rounds never repeat early)."""
    if not shard:
        raise ValueError("empty shard; use fewer workers or more data")
    start = (r * per_round) % len(shard)
    return [shard[(start + i) % len(shard)] for i in range(per_round)]


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(l) for l in Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]


# ── validation loss of an adapter (same encoding and loss as train_tools.evaluate) ──

def validation_loss(prefix: Path, cfg: dict, llm_dir: str) -> float:
    """Token-weighted assistant-token loss over the whole validation set."""
    import torch
    sys.path.insert(0, str(HERE / "multimodal"))
    import lora_bitlinear as lb
    from forge.tool_data import encode_trajectory, load_trajectories
    from forge.train_tools import initialize_adapter

    smoke = cfg["smoke"]
    languages = tuple(cfg["languages"])
    rows = load_trajectories(cfg["validation"], languages)
    torch.manual_seed(cfg["seed"])
    if smoke:
        from mm_model import build_tiny_bitnet_llm

        class TinyTokenizer:
            eos_token_id = 1

            def encode(self, text, add_special_tokens=False):
                return [2 + (ord(c) % 60) for c in text]
        tok = TinyTokenizer()
        base, _ = build_tiny_bitnet_llm(16, 64, 0, 1, layers=1, heads=2, kv_heads=1, ffn=32, max_pos=cfg["max_length"])
        base.requires_grad_(False)
        device = torch.device("cpu")
    else:
        from transformers import AutoTokenizer
        tok = AutoTokenizer.from_pretrained(llm_dir, local_files_only=True)
        base = lb.load_frozen_base("offline", llm_dir)
        device = torch.device("cuda")
    base = base.to(device)
    lb.inject_lora(base, r=cfg["rank"], alpha=cfg["alpha"], dropout=0.0)
    base.to(device)
    initialize_adapter(base, str(prefix), lb, "smoke" if smoke else "offline", cfg["rank"], cfg["alpha"])
    base.eval()
    total = count = 0.0
    with torch.no_grad():
        for row in rows:
            enc = encode_trajectory(row, tok, cfg["max_length"])
            ids = torch.tensor([enc["input_ids"]], device=device)
            labels = torch.tensor([enc["labels"]], device=device)
            with torch.autocast(device.type, dtype=torch.bfloat16, enabled=not smoke):
                loss = base(input_ids=ids, labels=labels, attention_mask=torch.ones_like(ids)).loss.item()
            if not math.isfinite(loss):
                raise ValueError("non-finite validation loss")
            n = int((labels[:, 1:] != -100).sum())
            total, count = total + loss * n, count + n
    del base
    if not smoke:
        torch.cuda.empty_cache()
    return total / count


# ── commands ──

def init_run(root: Path, parent: Path, train: Path, validation: Path, workers: int, inner_steps: int,
             rounds: int, languages: list[str], llm_dir: str | None, smoke: bool = False, evaluate=None,
             **settings) -> dict:
    root = Path(root)
    if (root / "run.json").exists():
        raise FileExistsError(f"{root} already has a run.json")
    cfg = {"schema": SCHEMA, "workers": workers, "inner_steps": inner_steps, "rounds": rounds,
           "train": str(train), "validation": str(validation),
           "train_sha256": sha256_file(train), "validation_sha256": sha256_file(validation),
           "languages": languages, "smoke": smoke, "parent": str(parent),
           "parent_sha256": {"safetensors": sha256_file(str(parent) + ".safetensors"),
                             "json": sha256_file(str(parent) + ".json")},
           "lr": 1e-4, "batch": 1, "accum": 8, "max_length": 2048, "rank": 16, "alpha": 32, "seed": 42,
           "outer_lr": 0.7, "outer_momentum": 0.9, "max_regression": 0.02, "max_norm_ratio": 3.0,
           "min_workers": max(1, workers - 1), "timeout_minutes": 240}
    cfg.update(settings)
    if workers < 1 or inner_steps < 1 or rounds < 1 or not 1 <= cfg["min_workers"] <= workers:
        raise ValueError("workers, inner_steps, rounds >= 1 and 1 <= min_workers <= workers required")
    tensors, meta = load_adapter(parent)
    check_finite(tensors)
    write_json_once(root / "run.json", cfg)
    rd = round_dir(root, 0)
    hashes = save_adapter(rd / "global", tensors, meta)
    if evaluate is not None:
        loss = evaluate(rd / "global")
    else:
        loss = validation_loss(rd / "global", cfg, llm_dir) if llm_dir or smoke else None
    write_json_once(rd / "global.manifest.json", {**hashes, "round": 0, "validation_loss": loss,
                                                  "source": "init", "parent": str(parent)})
    return cfg


def load_run(root: Path) -> dict:
    cfg = read_json(Path(root) / "run.json")
    for key in ("train", "validation"):
        if sha256_file(cfg[key]) != cfg[key + "_sha256"]:
            raise ValueError(f"{key} data changed since the run started")
    return cfg


def worker_round(root: Path, r: int, worker: int, llm_dir: str, poll: float = 30.0, retries: int = 2) -> dict:
    root, cfg = Path(root), load_run(root)
    rd = round_dir(root, r)
    done = rd / f"worker-{worker}.done.json"
    if done.exists():
        return read_json(done)  # retry after a crash: this round is already delivered
    wait_for(rd / "global.manifest.json", cfg["timeout_minutes"] * 60, poll, f"round {r} global")
    manifest = read_json(rd / "global.manifest.json")
    global_t, _ = load_adapter(rd / "global", manifest)
    per_round = cfg["inner_steps"] * cfg["accum"] * cfg["batch"]
    rows = round_slice(shard_rows(read_jsonl(cfg["train"]), cfg["workers"], worker, cfg["seed"]), r, per_round)
    with tempfile.TemporaryDirectory(prefix=f"diloco-w{worker}-r{r}-") as tmp:
        tmp = Path(tmp)
        shutil.copyfile(rd / "global.safetensors", tmp / "init.safetensors")
        shutil.copyfile(rd / "global.json", tmp / "init.json")
        (tmp / "train.jsonl").write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in rows), encoding="utf-8")
        cmd = [sys.executable, "-u", "-m", "forge.train_tools", "--train", str(tmp / "train.jsonl"),
               "--validation", cfg["validation"], "--languages", ",".join(cfg["languages"]),
               "--llm-dir", llm_dir or "unused-smoke-model", "--init-adapter", str(tmp / "init"),
               "--steps", str(cfg["inner_steps"]), "--checkpoint-every", str(cfg["inner_steps"]),
               "--log-every", str(max(1, cfg["inner_steps"] // 4))]
        for k in ("lr", "batch", "accum", "max_length", "rank", "alpha", "seed"):
            cmd += ["--" + k.replace("_", "-"), str(cfg[k])]
        if cfg["smoke"]:
            cmd.append("--smoke")
        else:
            cmd.append("--gradient-checkpointing")
        last = None
        for attempt in range(retries + 1):
            out = tmp / f"out-{attempt}"
            proc = subprocess.run(cmd + ["--out", str(out)], cwd=HERE.parent, capture_output=True, text=True)
            if proc.returncode == 0:
                break
            last = proc.stdout[-2000:] + proc.stderr[-4000:]
        else:
            raise RuntimeError(f"worker {worker} round {r} failed after {retries + 1} attempts:\n{last}")
        tensors, meta = load_adapter(out / f"adapter-step{cfg['inner_steps']}")
    check_finite(tensors)
    hashes = save_adapter(rd / f"worker-{worker}", tensors, meta)
    record = {**hashes, "round": r, "worker": worker, "rows": len(rows),
              "first_row_sha256": row_key(rows[0]), "global_sha256": manifest["safetensors_sha256"],
              "update_norm": delta_norm(tensors, global_t),
              "worker_validation_loss": meta.get("validation_assistant_loss")}
    write_json_once(done, record)
    return record


def merge_round(root: Path, r: int, llm_dir: str | None, poll: float = 30.0, evaluate=None) -> dict:
    import torch
    from safetensors.torch import load_file, save as save_bytes
    root, cfg = Path(root), load_run(root)
    rd, nxt = round_dir(root, r), round_dir(root, r + 1)
    if (nxt / "global.manifest.json").exists():
        return read_json(rd / "merge.json")
    evaluate = evaluate or (lambda prefix: validation_loss(prefix, cfg, llm_dir))
    deadline = time.monotonic() + cfg["timeout_minutes"] * 60
    while True:
        ready = [w for w in range(cfg["workers"]) if (rd / f"worker-{w}.done.json").exists()]
        if len(ready) == cfg["workers"] or (time.monotonic() > deadline and len(ready) >= cfg["min_workers"]):
            break
        if time.monotonic() > deadline:
            raise TimeoutError(f"round {r}: only {len(ready)}/{cfg['workers']} workers finished")
        time.sleep(poll)
    manifest = read_json(rd / "global.manifest.json")
    global_t, global_meta = load_adapter(rd / "global", manifest)
    accepted, rejected = [], {}
    for w in ready:
        done = read_json(rd / f"worker-{w}.done.json")
        try:
            if done["global_sha256"] != manifest["safetensors_sha256"]:
                raise ValueError("trained from a different global")
            t, _ = load_adapter(rd / f"worker-{w}", done)
            if set(t) != set(global_t):
                raise ValueError("tensor keys differ from the global")
            check_finite(t)
            accepted.append((w, t, delta_norm(t, global_t)))
        except (ValueError, KeyError, OSError) as err:
            rejected[w] = str(err)
    norms = sorted(n for _, _, n in accepted)
    if norms:
        median = norms[len(norms) // 2]
        for w, _, n in accepted:
            if median > 0 and n > cfg["max_norm_ratio"] * median:
                rejected[w] = f"update norm {n:.4g} > {cfg['max_norm_ratio']} x median {median:.4g}"
        accepted = [a for a in accepted if a[0] not in rejected]
    if len(accepted) < cfg["min_workers"]:
        raise RuntimeError(f"round {r}: {len(accepted)} usable workers < min_workers; rejected={rejected}")
    state_path = root / "outer-state" / f"round-{r - 1:04d}.safetensors"
    momentum = load_file(str(state_path)) if r > 0 and state_path.exists() else None
    base_loss = manifest.get("validation_loss")
    attempts = [(cfg["outer_lr"], cfg["outer_momentum"], momentum), (cfg["outer_lr"] / 2, cfg["outer_momentum"], momentum),
                (1.0, 0.0, None)]
    trials, chosen = [], None
    with tempfile.TemporaryDirectory(prefix=f"diloco-merge-r{r}-") as tmp:
        for i, (lr, mu, m) in enumerate(attempts):
            cand, new_m = outer_step(global_t, [t for _, t, _ in accepted], m, lr, mu)
            check_finite(cand)
            prefix = Path(tmp) / f"candidate-{i}"
            save_adapter(prefix, cand, global_meta)
            loss = evaluate(prefix)
            ok = base_loss is None or loss <= base_loss * (1 + cfg["max_regression"])
            trials.append({"outer_lr": lr, "outer_momentum": mu, "validation_loss": loss, "accepted": ok})
            if ok:
                chosen = (cand, new_m, loss, "merged")
                break
    if chosen is None:  # every candidate regressed: keep the previous global, reset momentum
        chosen = (global_t, None, base_loss, "carried-forward")
    cand, new_m, loss, source = chosen
    # JSON object keys are strings; build the record that way so a re-read equals what was returned.
    record = {"round": r, "accepted_workers": [w for w, _, _ in accepted],
              "rejected_workers": {str(w): why for w, why in sorted(rejected.items())},
              "update_norms": {str(w): n for w, _, n in accepted}, "previous_validation_loss": base_loss,
              "trials": trials, "result": source, "validation_loss": loss}
    write_json_once(rd / "merge.json", record)
    if new_m is not None:
        write_once(root / "outer-state" / f"round-{r:04d}.safetensors", save_bytes({k: v.contiguous() for k, v in new_m.items()}))
    hashes = save_adapter(nxt / "global", cand, global_meta)
    write_json_once(nxt / "global.manifest.json", {**hashes, "round": r + 1, "validation_loss": loss,
                                                   "source": source, "merge_sha256": sha256_file(rd / "merge.json")})
    return record


def run_worker(root: Path, worker: int, llm_dir: str, poll: float = 30.0) -> None:
    cfg = load_run(root)
    for r in range(cfg["rounds"]):
        rec = worker_round(root, r, worker, llm_dir, poll)
        print(json.dumps({"round": r, "worker": worker, "update_norm": rec["update_norm"]}), flush=True)
        if worker == 0:
            m = merge_round(root, r, llm_dir, poll)
            print(json.dumps({"round": r, "merge": m["result"], "validation_loss": m["validation_loss"],
                              "accepted": m["accepted_workers"], "rejected": m["rejected_workers"]}), flush=True)
        else:
            wait_for(round_dir(root, r + 1) / "global.manifest.json", cfg["timeout_minutes"] * 60, poll,
                     f"round {r + 1} global")
    final = round_dir(root, cfg["rounds"])
    print("Final shared adapter:", final / "global", flush=True)


def smoke(root: Path | None = None) -> dict:
    """CPU plumbing check: tiny random BitNet, 2 workers, 2 rounds, real trainer subprocesses."""
    from forge.test_tool_data import row
    tmp = Path(root or tempfile.mkdtemp(prefix="diloco-smoke-"))
    train, val = tmp / "train.jsonl", tmp / "val.jsonl"
    train.write_text("".join(json.dumps(row(f"Training question {i}")) + "\n" for i in range(16)), encoding="utf-8")
    val.write_text(json.dumps(row("Held out question")) + "\n", encoding="utf-8")
    seed_out = tmp / "seed-adapter"
    subprocess.run([sys.executable, "-m", "forge.train_tools", "--smoke", "--train", str(train), "--validation", str(val),
                    "--llm-dir", "unused-smoke-model", "--out", str(seed_out), "--steps", "1", "--accum", "1",
                    "--rank", "2", "--alpha", "4", "--max-length", "512"], cwd=HERE.parent, check=True,
                   capture_output=True, text=True)
    run = tmp / "run"
    # Large regression tolerance: the tiny random model's loss is noise; the gate itself is unit-tested.
    init_run(run, seed_out / "adapter-step1", train, val, workers=2, inner_steps=2, rounds=2, languages=["en"],
             llm_dir=None, smoke=True, rank=2, alpha=4, accum=1, max_length=512, min_workers=2, max_regression=1.0)
    for r in range(2):
        for w in range(2):
            worker_round(run, r, w, None, poll=0.1)
        merge_round(run, r, None, poll=0.1)
    return {"root": str(run), "merge": [read_json(round_dir(run, r) / "merge.json") for r in range(2)]}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("init")
    p.add_argument("--root", required=True)
    p.add_argument("--parent", required=True, help="adapter export prefix (no extension)")
    p.add_argument("--train", required=True)
    p.add_argument("--validation", required=True)
    p.add_argument("--languages", default="en")
    p.add_argument("--workers", type=int, required=True)
    p.add_argument("--inner-steps", type=int, default=100)
    p.add_argument("--rounds", type=int, default=10)
    p.add_argument("--llm-dir", help="needed to record the round-0 validation loss")
    for k, t in (("lr", float), ("accum", int), ("max-length", int), ("outer-lr", float),
                 ("outer-momentum", float), ("max-regression", float), ("min-workers", int), ("timeout-minutes", float)):
        p.add_argument("--" + k, type=t)
    p = sub.add_parser("worker")
    p.add_argument("--root", required=True)
    p.add_argument("--worker-id", type=int, required=True)
    p.add_argument("--llm-dir", required=True)
    p.add_argument("--poll", type=float, default=30.0)
    p = sub.add_parser("smoke")
    p.add_argument("--root")
    a = ap.parse_args(argv)
    if a.cmd == "init":
        extra = {k.replace("-", "_"): getattr(a, k.replace("-", "_")) for k in
                 ("lr", "accum", "max_length", "outer_lr", "outer_momentum", "max_regression", "min_workers",
                  "timeout_minutes") if getattr(a, k.replace("-", "_")) is not None}
        print(json.dumps(init_run(Path(a.root), Path(a.parent), Path(a.train), Path(a.validation), a.workers,
                                  a.inner_steps, a.rounds, a.languages.split(","), a.llm_dir, **extra), indent=2))
    elif a.cmd == "worker":
        run_worker(Path(a.root), a.worker_id, a.llm_dir, a.poll)
    else:
        print(json.dumps(smoke(Path(a.root) if a.root else None), indent=2))


if __name__ == "__main__":
    main()
