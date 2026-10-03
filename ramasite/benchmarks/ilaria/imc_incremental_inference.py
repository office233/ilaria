"""Paired public tiny-IMC baseline/cached benchmark; no checkpoints or training jobs.

Supply an explicitly owned, hash-pinned copy of the original canonical Python
source. All weights are random fixtures generated in memory by the same IMC.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import statistics
import sys
import time
from pathlib import Path
import sys as _nexus_sys
_nexus_sys.path.insert(0, str(Path(__file__).resolve().parents[0]))
from nexus_ilaria_benchmark_paths import ilaria_root

import torch
sys.path.insert(0, str(ilaria_root(__file__) / "forge"))
from imc_model import ImcConfig, ImcTransformer, InferencePolicy, PRESETS


def baseline_module(path, expected):
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError("baseline public-source SHA256 mismatch")
    spec = importlib.util.spec_from_file_location("imc_uncached_reference", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def models(original, seed, **config):
    cfg = dict(vocab_size=64, d_model=32, n_layers=2, n_heads=4, n_kv_heads=2,
               ffn_dim=48, eos_token_id=3, max_seq_len=64)
    cfg.update(config)
    torch.manual_seed(seed)
    candidate = ImcTransformer(ImcConfig(**cfg))
    reference = original.ImcTransformer(original.ImcConfig(**cfg))
    reference.load_state_dict(candidate.state_dict(), strict=True)
    assert candidate.cfg.to_json() == reference.cfg.to_json()
    assert tuple(candidate.state_dict()) == tuple(reference.state_dict())
    assert candidate.param_count() == reference.param_count()
    return candidate, reference


def training_gate(original):
    assert PRESETS == original.PRESETS
    cases = 0
    ids = torch.tensor([[2, 5, 7, 9], [9, 7, 5, 2]])
    targets = (ids + 1) % 64
    for seed in [0, 19]:
        for ternary in [False, True]:
            for gate in ["silu", "relu2"]:
                for subln in [False, True]:
                    a, b = models(original, seed, ternary=ternary, ffn_act=gate, subln=subln)
                    for checkpoint in [False, True]:
                        for m in [a, b]:
                            m.train(); m.enable_gradient_checkpointing(checkpoint); m.zero_grad()
                        torch.testing.assert_close(a(ids), b(ids), atol=0, rtol=0)
                        left = a(ids, targets, loss_chunk_tokens=3)
                        right = b(ids, targets, loss_chunk_tokens=3)
                        torch.testing.assert_close(left, right, atol=0, rtol=0)
                        left.backward(); right.backward()
                        for p, q in zip(a.parameters(), b.parameters()):
                            torch.testing.assert_close(p.grad, q.grad, atol=0, rtol=0)
                        for name, value in a.state_dict().items():
                            torch.testing.assert_close(value, b.state_dict()[name], atol=0, rtol=0)
                        cases += 1
    return cases


def memory():
    try:
        import psutil
        info = psutil.Process().memory_info()
        return {"rss_bytes": info.rss, "process_peak_wset_bytes": getattr(info, "peak_wset", None)}
    except ImportError:
        if sys.platform == "win32":
            import ctypes
            from ctypes import wintypes
            class Counters(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("page_faults", wintypes.DWORD)] + [
                    (name, ctypes.c_size_t) for name in (
                        "peak_wset", "wset", "peak_paged", "paged", "peak_nonpaged",
                        "nonpaged", "pagefile", "peak_pagefile")]
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.GetCurrentProcess.restype = wintypes.HANDLE
            query = ctypes.WinDLL("psapi", use_last_error=True).GetProcessMemoryInfo
            query.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
            query.restype = wintypes.BOOL
            counters = Counters()
            counters.cb = ctypes.sizeof(counters)
            if query(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
                return {"rss_bytes": counters.wset, "process_peak_wset_bytes": counters.peak_wset,
                        "provider": "windows_process_memory_info"}
        return {"rss_bytes": None, "process_peak_wset_bytes": None, "provider": "unavailable"}


def profile(model, prefix, max_new, policy):
    """Separate diagnostic phase; hooks never appear in paired timed samples."""
    state, tokens = None, list(prefix)
    rows, peak_cache, peak_reservation = [], 0, 0
    for _ in range(max_new):
        chunk = torch.tensor([tokens] if state is None else [[tokens[-1]]], dtype=torch.long)
        first_layer = []
        hook = model.blocks[0].register_forward_pre_hook(lambda *args: first_layer.append(time.perf_counter_ns()))
        start = time.perf_counter_ns()
        try:
            logits, state = model.inference_step(chunk, policy=policy, stream_id="profile", weights_epoch=0, state=state)
        finally:
            hook.remove()
        stop = time.perf_counter_ns()
        rows.append({"kind": "prefill/rebuild" if state.rebuilt else "decode",
                     "admission_embedding_ns": first_layer[0] - start,
                     "total_step_ns": stop-start, "position": state.position})
        peak_cache = max(peak_cache, state.cache_bytes)
        peak_reservation = max(peak_reservation, state.reserved_bytes)
        nxt = int(logits[0].argmax())
        tokens.append(nxt)
        if nxt == model.cfg.eos_token_id:
            break
    return {"completion": tokens, "steps": rows, "peak_live_cache_bytes": peak_cache,
            "peak_admitted_cache_staging_bytes": peak_reservation}


def summary(samples):
    values = [s["wall_ns_per_generation"] for s in samples]
    cpu = [s["cpu_ns_per_generation"] for s in samples]
    return {"median_wall_ns": statistics.median(values), "min_wall_ns": min(values),
            "max_wall_ns": max(values), "median_cpu_ns": statistics.median(cpu), "samples": samples}


def run_preset(args, original):
    """One bounded canonical random-initialized CPU preset pair."""
    if args.samples > 3 or args.max_seconds > 120 or not 0 < args.rss_cap_bytes <= 2_684_354_560:
        raise ValueError("preset permits at most 3 samples, 120 seconds and 2.5 GiB RSS")
    start, deadline = time.perf_counter(), time.monotonic() + args.max_seconds
    observed_rss, observed_peak = 0, 0
    def check():
        nonlocal observed_rss, observed_peak
        info = memory()
        if info["rss_bytes"] is None:
            raise RuntimeError("preset refused: process RSS counter unavailable")
        observed_rss = max(observed_rss, info["rss_bytes"])
        observed_peak = max(observed_peak, info["process_peak_wset_bytes"] or info["rss_bytes"])
        if max(observed_rss, observed_peak) > args.rss_cap_bytes:
            raise RuntimeError("preset process RSS cap exceeded")
        if time.monotonic() >= deadline:
            raise RuntimeError("preset time budget exceeded, including setup")
        return False
    check()
    verified = training_gate(original)
    check()
    config = ImcConfig.preset("imc-125m", vocab_size=65536, eos_token_id=61440, max_seq_len=128)
    raw_model_bytes = 2 * config.param_count() * 4
    if observed_rss + raw_model_bytes + 256 * 1024**2 > args.rss_cap_bytes:
        raise RuntimeError("preset refused before model allocation: paired model residency reserve")
    setup = time.perf_counter_ns()
    torch.manual_seed(0)
    candidate = ImcTransformer(config).eval()
    check()
    reference = original.ImcTransformer(original.ImcConfig(**config.to_json())).eval()
    check()
    reference.load_state_dict(candidate.state_dict(), strict=True)
    assert tuple(candidate.state_dict()) == tuple(reference.state_dict())
    assert candidate.cfg.to_json() == reference.cfg.to_json()
    assert candidate.param_count() == reference.param_count() == config.param_count()
    setup = time.perf_counter_ns() - setup
    check()
    prefix, max_new = [(i * 7 + 2) % 65536 for i in range(32)], 8
    policy = InferencePolicy(64 * 1024**2, 128, 1, 128, deadline=deadline, cancelled=check)
    before = lambda: reference.generate_greedy(prefix, max_new)
    after = lambda: candidate.generate_greedy(prefix, max_new, inference_policy=policy, stream_id="preset", weights_epoch=0)
    expected = before()
    check()
    assert after() == expected
    phases = profile(candidate, prefix, max_new, policy)
    assert phases.pop("completion") == expected
    check()
    def sample(fn):
        check()
        wall, cpu = time.perf_counter_ns(), time.process_time_ns()
        completion = fn()
        elapsed, cpu_elapsed = time.perf_counter_ns() - wall, time.process_time_ns() - cpu
        assert completion == expected
        check()
        return {"repetitions": 1, "elapsed_wall_ns": elapsed,
                "wall_ns_per_generation": elapsed, "cpu_ns_per_generation": cpu_elapsed}
    left, right = [], []
    for i in range(args.samples):
        if i % 2:
            right.append(sample(after)); left.append(sample(before))
        else:
            left.append(sample(before)); right.append(sample(after))
    baseline, cached = summary(left), summary(right)
    return {"result": "PASS", "preset": "imc-125m", "baseline_training_identity_cases": verified,
            "baseline_source_sha256": args.baseline_sha256,
            "candidate_source_sha256": hashlib.sha256((ilaria_root(__file__) / "forge" / "imc_model.py").read_bytes()).hexdigest(),
            "torch": torch.__version__, "threads": torch.get_num_threads(), "device": "cpu", "dtype": "float32", "seed": 0,
            "samples": args.samples, "active_seconds_including_setup": time.perf_counter() - start,
            "two_model_setup_ns": setup, "model_config": config.to_json(), "model_parameters": candidate.param_count(),
            "two_model_parameter_storage_bytes": raw_model_bytes, "rss_cap_bytes": args.rss_cap_bytes,
            "observed_rss_bytes": observed_rss, "process_peak_wset_bytes": observed_peak,
            "prompt_tokens": len(prefix), "generated_tokens": len(expected) - len(prefix), "window": 128,
            "baseline": baseline, "cached": cached,
            "baseline_over_cached_median_wall_ratio": baseline["median_wall_ns"] / cached["median_wall_ns"],
            "diagnostic_phases": phases, "energy_joules": None,
            "memory_scope": "whole paired process, including Torch, training identity fixtures and both random preset models; not isolated operator peaks"}


def run(args):
    if not __debug__:
        raise RuntimeError("benchmark requires assertion checks; Python -O is unsupported")
    if not 1 <= args.samples <= 25 or not 0 < args.max_seconds <= 150:
        raise ValueError("samples must be 1..25 and active budget at most 150 seconds")
    torch.set_num_threads(args.threads)
    original = baseline_module(args.baseline_model, args.baseline_sha256)
    if args.preset == "imc-125m":
        if args.verify_only:
            raise ValueError("use tiny --verify-only for identity checks")
        return run_preset(args, original)
    verified = training_gate(original)
    if args.verify_only:
        return {"baseline_training_identity_cases": verified, "result": "PASS"}
    active_start = time.perf_counter()
    def check():
        if time.perf_counter()-active_start >= args.max_seconds:
            raise RuntimeError("active benchmark time budget exceeded")
    def sample(fn, expected):
        repetitions = 1
        while True:
            check()
            wall, cpu = time.perf_counter_ns(), time.process_time_ns()
            for _ in range(repetitions):
                check()
                if fn() != expected:
                    raise AssertionError("greedy sequence differs from the frozen baseline")
            elapsed, cpu_elapsed = time.perf_counter_ns()-wall, time.process_time_ns()-cpu
            if elapsed >= 25_000_000:
                return {"repetitions": repetitions, "elapsed_wall_ns": elapsed,
                        "wall_ns_per_generation": elapsed/repetitions,
                        "cpu_ns_per_generation": cpu_elapsed/repetitions}
            if repetitions >= 1 << 20:
                raise RuntimeError("sample could not reach the bounded timer interval")
            repetitions *= 2
    results = []
    for ternary in [False, True]:
        for label, prompt_length, max_new, window in [
            ("short", 1, 1, 16), ("within-window", 64, 24, 128),
            ("rollover", 16, 12, 16), ("above-window", 21, 8, 16),
        ]:
            check()
            setup = time.perf_counter_ns()
            candidate, reference = models(original, 0, ternary=ternary, max_seq_len=window)
            candidate.eval(); reference.eval()
            setup = time.perf_counter_ns()-setup
            prefix = [(i*7+2) % 64 for i in range(prompt_length)]
            policy = InferencePolicy(1_000_000, window, 1, 512)
            before = lambda: reference.generate_greedy(prefix, max_new)
            after = lambda: candidate.generate_greedy(prefix, max_new, inference_policy=policy, stream_id="bench", weights_epoch=0)
            expected = before()
            assert after() == expected
            phases = profile(candidate, prefix, max_new, policy)
            assert phases.pop("completion") == expected
            # All phases and parity checks complete before measuring this pair.
            for _ in range(2):
                assert before() == after() == expected
            left, right = [], []
            rss_before = memory()
            for i in range(args.samples):
                if i % 2:
                    right.append(sample(after, expected)); left.append(sample(before, expected))
                else:
                    left.append(sample(before, expected)); right.append(sample(after, expected))
            baseline_summary, cached_summary = summary(left), summary(right)
            results.append({"case": label, "ternary": ternary, "prompt_tokens": len(prefix),
                            "generated_tokens": len(expected)-len(prefix), "window": window,
                            "two_model_setup_ns": setup, "baseline": baseline_summary, "cached": cached_summary,
                            "baseline_over_cached_median_wall_ratio": baseline_summary["median_wall_ns"] / cached_summary["median_wall_ns"],
                            "model_config": candidate.cfg.to_json(), "model_parameters": candidate.param_count(),
                            "diagnostic_phases": phases, "rss_before": rss_before, "rss_after": memory()})
    return {"result": "PASS", "baseline_training_identity_cases": verified, "torch": torch.__version__,
            "baseline_source_sha256": args.baseline_sha256,
            "candidate_source_sha256": hashlib.sha256((ilaria_root(__file__) / "forge" / "imc_model.py").read_bytes()).hexdigest(),
            "threads": torch.get_num_threads(), "device": "cpu", "dtype": "float32", "seed": 0,
            "active_benchmark_seconds": time.perf_counter()-active_start, "samples": args.samples,
            "results": results, "energy_joules": None,
            "memory_scope": "whole paired process, including Torch and both tiny models; not isolated per-operator peaks"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-model", required=True, type=Path)
    parser.add_argument("--baseline-sha256", required=True)
    parser.add_argument("--samples", type=int, default=9)
    parser.add_argument("--threads", type=int, choices=[1, 2], default=1)
    parser.add_argument("--max-seconds", type=float, default=120)
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--preset", choices=["tiny", "imc-125m"], default="tiny")
    parser.add_argument("--rss-cap-bytes", type=int, default=2_684_354_560)
    args = parser.parse_args()
    print(json.dumps(run(args), indent=2))


if __name__ == "__main__":
    main()
