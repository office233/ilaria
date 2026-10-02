"""Freeze a provenance-preserving, grouped code-only scale-validation package.

This adapter consumes only the new licensed FreeRTOS/Zephyr candidate. It is
not a production-mixture builder and never declares production approval.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import ctypes
import ctypes.wintypes
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import sys
import time

FORMAT = "ilaria-licensed-code-scale-validation-v1"
STATUS = "NON_PROMOTABLE_CODE_ONLY_SCALE_VALIDATION"
MAX_OUTPUT_BYTES = 1024**3
MAX_SECONDS = 15 * 60
MAX_RSS_BYTES = 1024**3
SPLITS = ("train", "validation", "sealed")
SPLIT_POLICY = "sha256-connected-module-family-buckets-v1"
DEFAULT_CONFIG = Path(__file__).with_name("pilot_config.json")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_json_sha256(value: dict) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True,
            separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def family_key(row: dict) -> str:
    source, revision, raw_path = row.get("source"), row.get("revision"), row.get("path")
    if not all(isinstance(value, str) and value for value in (source, revision, raw_path)):
        raise ValueError("source/revision/path provenance is missing")
    path = PurePosixPath(raw_path)
    if path.is_absolute() or "\\" in raw_path or any(p in {"", ".", ".."} for p in path.parts):
        raise ValueError("unsafe source path")
    parts = path.parts
    if len(parts) == 1:
        family = path.stem
    else:
        # First two repository modules keep related files together without
        # collapsing an entire large repository into one split group.
        family = "/".join(parts[:2])
    return f"{source}@{revision}:{family}"


class DisjointSet:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, value: str) -> str:
        self.parent.setdefault(value, value)
        root = value
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[value] != value:
            parent = self.parent[value]
            self.parent[value] = root
            value = parent
        return root

    def union(self, left: str, right: str) -> None:
        a, b = self.find(left), self.find(right)
        if a != b:
            low, high = sorted((a, b))
            self.parent[high] = low


def group_components(aliases: list[dict]) -> dict[str, str]:
    """Map each exact body digest to its connected module-family component."""
    groups = DisjointSet()
    by_body: dict[str, set[str]] = defaultdict(set)
    for alias in aliases:
        digest = alias.get("body_byte_sha256")
        if not isinstance(digest, str) or len(digest) != 64:
            raise ValueError("invalid body digest in alias group")
        by_body[digest].add(family_key(alias))
    for families in by_body.values():
        ordered = sorted(families)
        for other in ordered[1:]:
            groups.union(ordered[0], other)
    return {digest: groups.find(sorted(families)[0]) for digest, families in by_body.items()}


def split_for_group(group: str, seed: str) -> str:
    bucket = int(hashlib.sha256(f"{seed}\0{group}".encode("utf-8")).hexdigest()[:8], 16) % 100
    if bucket < 80:
        return "train"
    if bucket < 90:
        return "validation"
    return "sealed"


def _check_time(started: float) -> None:
    if time.monotonic() - started > MAX_SECONDS:
        raise ValueError("15-minute package wall budget exceeded")


def _check_rss() -> None:
    if os.name == "nt":
        class Counters(ctypes.Structure):
            _fields_ = [("cb", ctypes.wintypes.DWORD),
                        ("PageFaultCount", ctypes.wintypes.DWORD),
                        ("PeakWorkingSetSize", ctypes.c_size_t),
                        ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t),
                        ("PeakPagefileUsage", ctypes.c_size_t)]
        counters = Counters()
        counters.cb = ctypes.sizeof(Counters)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        kernel32.GetCurrentProcess.restype = ctypes.wintypes.HANDLE
        psapi.GetProcessMemoryInfo.argtypes = [
            ctypes.wintypes.HANDLE, ctypes.POINTER(Counters), ctypes.wintypes.DWORD]
        psapi.GetProcessMemoryInfo.restype = ctypes.wintypes.BOOL
        if not psapi.GetProcessMemoryInfo(
                kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
            raise RuntimeError("could not measure process working set")
        rss = counters.WorkingSetSize
    else:
        import resource
        usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        rss = usage if sys.platform == "darwin" else usage * 1024
    if rss > MAX_RSS_BYTES:
        raise ValueError("1 GiB process RSS cap exceeded")


def validate_package_manifest(package_dir: Path) -> dict:
    manifest = _load_json(package_dir / "code-only-pilot-package.json")
    payload = dict(manifest)
    declared = payload.pop("package_sha256", None)
    if declared != canonical_json_sha256(payload):
        raise ValueError("pilot package manifest hash mismatch")
    if manifest.get("status") != STATUS or manifest.get("production_dataset_approved") is not False:
        raise ValueError("pilot package status/approval mismatch")
    group_to_split: dict[str, str] = {}
    body_to_split: dict[str, str] = {}
    file_to_group: dict[tuple[str, str, str], str] = {}
    split_groups = Counter()
    for split in SPLITS:
        entry = manifest.get("counts", {}).get(split)
        if not isinstance(entry, dict):
            raise ValueError(f"pilot split metadata missing: {split}")
        for filename, hash_field, bytes_field in (
            (f"{split}.jsonl", "jsonl_sha256", "jsonl_bytes"),
            (f"{split}.tokens.bin", "stream_sha256", "stream_bytes"),
            (f"{split}.tokens.json", "stream_metadata_sha256", "stream_metadata_bytes"),
        ):
            path = package_dir / filename
            if not path.is_file() or path.stat().st_size != entry.get(bytes_field) or sha256_file(path) != entry.get(hash_field):
                raise ValueError(f"pilot package artifact hash/size mismatch: {filename}")
        _validate_canonical_stream_metadata(package_dir, split, entry, manifest)
        rows = documents = tokens = 0
        seen_bodies = set()
        with (package_dir / f"{split}.jsonl").open(encoding="utf-8") as stream:
            for line_no, line in enumerate(stream, 1):
                row = json.loads(line)
                if (not isinstance(row, dict) or
                        row.get("schema") != "ilaria-licensed-code-scale-validation-row-v1" or
                        row.get("split") != split or not row.get("source_group") or
                        not row.get("source_provenance") or not isinstance(row.get("text"), str)):
                    raise ValueError(f"invalid grouped provenance row: {split}:{line_no}")
                group = row["source_group"]
                previous = group_to_split.get(group)
                if previous is not None and previous != split:
                    raise ValueError("a module-family group crosses package splits")
                group_to_split[group] = split
                split_groups[split] += 1 if previous is None else 0
                body_digest = row.get("body_byte_sha256")
                if not isinstance(body_digest, str) or len(body_digest) != 64:
                    raise ValueError("invalid body digest in pilot row")
                if body_digest in seen_bodies:
                    raise ValueError("duplicate exact body in pilot split")
                seen_bodies.add(body_digest)
                previous = body_to_split.get(body_digest, split)
                if previous != split:
                    raise ValueError("an exact-body alias crosses package splits")
                body_to_split[body_digest] = split
                for provenance in row["source_provenance"]:
                    file_key = (provenance.get("source"), provenance.get("revision"), provenance.get("path"))
                    previous = file_to_group.get(file_key)
                    if previous is not None and previous != group:
                        raise ValueError("one source file crosses module groups")
                    file_to_group[file_key] = group
                rows += 1
                documents += 1
                tokens += row.get("tokens_including_eos", 0)
        if rows != entry.get("documents") or tokens != entry.get("tokens_including_eos"):
            raise ValueError(f"pilot JSONL accounting mismatch: {split}")
        if tokens < manifest.get("minimum_tokens", {}).get(split, MAX_OUTPUT_BYTES):
            raise ValueError(f"pilot token minimum not met: {split}")
    if manifest.get("group_counts", {}).get("split_group_counts") != dict(split_groups):
        raise ValueError("pilot split group counts do not match rows")
    return manifest


def _validate_canonical_stream_metadata(package_dir: Path, split: str,
                                        entry: dict, manifest: dict) -> None:
    """Check canonical IlariaLex metadata, stream digest, dtype and byte length."""
    forge_root = Path(__file__).resolve().parents[2] / "forge"
    sys.path.insert(0, str(forge_root))
    from hf_tokenizer import EOS, ILARIALEX_BASE_VOCAB_SIZE, ILARIALEX_FORMAT, ILARIALEX_VOCAB_SIZE

    path = package_dir / f"{split}.tokens.json"
    metadata = _load_json(path)
    vocab = metadata.get("vocab_size")
    dtype = metadata.get("dtype")
    expected_dtype = "uint16" if isinstance(vocab, int) and vocab <= 65_536 else "uint32"
    if metadata.get("format") != "ilaria-token-stream-v1":
        raise ValueError(f"non-canonical token stream format: {split}")
    if vocab != ILARIALEX_VOCAB_SIZE or dtype != expected_dtype:
        raise ValueError(f"canonical token stream dtype/vocabulary mismatch: {split}")
    if (metadata.get("eos_id") != manifest.get("eos_id") or
            metadata.get("eos_id") != ILARIALEX_BASE_VOCAB_SIZE or
            manifest.get("eos_token") != EOS):
        raise ValueError(f"canonical token stream EOS mismatch: {split}")
    if (metadata.get("tokenizer_sha256") != manifest.get("tokenizer_sha256") or
            metadata.get("tokenizer_format") != ILARIALEX_FORMAT or
            metadata.get("protocol_start_id") != ILARIALEX_BASE_VOCAB_SIZE or
            metadata.get("byte_level") is not True):
        raise ValueError(f"canonical token stream tokenizer contract mismatch: {split}")
    if (metadata.get("tokens") != entry.get("tokens_including_eos") or
            metadata.get("documents") != entry.get("documents") or
            metadata.get("stream_sha256") != entry.get("stream_sha256")):
        raise ValueError(f"canonical token stream metadata/accounting mismatch: {split}")
    stream = package_dir / f"{split}.tokens.bin"
    item_bytes = 2 if dtype == "uint16" else 4
    if stream.stat().st_size != metadata["tokens"] * item_bytes:
        raise ValueError(f"canonical token stream byte length/dtype mismatch: {split}")


def _load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object: {path.name}")
    return value


def _validate_source_gates(package_root: Path, forge_root: Path,
                           package: dict, candidate_manifest: dict) -> dict:
    config = forge_root / "config"
    for name in ("corpus_sources.lock.json", "data_rights.json",
                 "data_rights_evidence.json", "git_sources.lock.json",
                 "data_contract.py", "rights_evidence.py", "licensed_tree_source.py",
                 "licensed_tree_corpus.py", "data_audit.py", "hf_tokenizer.py",
                 "corpus_source_lock.py", "git_source_lock.py"):
        # Acquisition recorded the canonical Main paths. Match by stable
        # suffix while resolving them against this checkout's current files.
        matches = [key for key in package.get("input_file_sha256", {})
                   if key.replace("/", "\\").endswith("\\ilaria\\forge\\" +
                       (("config\\" if name.endswith(".json") else "") + name))]
        if len(matches) != 1:
            raise ValueError(f"candidate does not pin exactly one {name}")
        source_path = (config / name) if name.endswith(".json") else (forge_root / name)
        if sha256_file(source_path) != package["input_file_sha256"][matches[0]]:
            raise ValueError(f"acquisition input drift: {name}")

    sys.path.insert(0, str(forge_root))
    from data_contract import load_rights_registry, require_approved_rights
    from rights_evidence import load_and_validate_evidence, require_approved_evidence

    rights_path = config / "data_rights.json"
    evidence_path = config / "data_rights_evidence.json"
    source_lock_path = config / "corpus_sources.lock.json"
    git_lock_path = config / "git_sources.lock.json"
    registry = load_rights_registry(rights_path)
    evidence = load_and_validate_evidence(
        evidence_path, source_lock_path=source_lock_path,
        rights_registry_path=rights_path, git_source_lock_path=git_lock_path)
    names = ["freertos_kernel", "zephyr"]
    require_approved_rights(registry, names)
    require_approved_evidence(registry, evidence, names)
    lock = _load_json(git_lock_path)
    source_reports = {item["source"]: item for item in package.get("source_reports", [])}
    if set(source_reports) != set(names):
        raise ValueError("candidate source set is not exactly the approved OS pair")

    # Bind both acquisition manifests and raw shard line numbers before any
    # split assignment. Also validate every source file hash/SPDX via the
    # canonical licensed-tree validator.
    from licensed_tree_source import validate_manifest
    raw_shard_index: dict[tuple[str, str], dict] = {}
    license_file_index: dict[tuple[str, str], dict] = {}
    source_inputs = {}
    for name in names:
        report = source_reports[name]
        locked = lock["sources"][name]
        if report.get("revision") != locked.get("commit"):
            raise ValueError(f"locked revision mismatch: {name}")
        registry_item = registry["sources"][name]
        if registry_item.get("status") != "APPROVED" or registry_item.get("commercial_use_approved") is not True:
            raise ValueError(f"current rights approval is absent: {name}")
        folder = package_root / name
        raw_manifest_path = folder / "raw" / f"{name}.manifest.json"
        if sha256_file(raw_manifest_path) != report["raw_manifest_sha256"]:
            raise ValueError(f"raw manifest mismatch: {name}")
        raw_manifest = _load_json(raw_manifest_path)
        if (raw_manifest.get("source", {}).get("name") != name or
                raw_manifest.get("source", {}).get("revision") != report.get("revision") or
                raw_manifest.get("docs") != report.get("documents")):
            raise ValueError(f"raw manifest identity/count mismatch: {name}")
        raw_records = {(item.get("filename"), item.get("sha256")): item
                       for item in raw_manifest.get("shard_records", [])}
        for shard in report["raw_shards"]:
            raw_record = raw_records.get((shard["filename"], shard["sha256"]))
            if not raw_record or raw_record.get("documents") != shard["documents"] or raw_record.get("bytes") != shard["bytes"]:
                raise ValueError(f"raw manifest shard membership mismatch: {name}")
            shard_path = folder / "raw" / shard["filename"]
            if sha256_file(shard_path) != shard["sha256"] or shard_path.stat().st_size != shard["bytes"]:
                raise ValueError(f"raw shard mismatch: {name}/{shard['filename']}")
            raw_shard_index[(name, shard["sha256"])] = {
                **shard, "path": shard_path, "manifest": raw_manifest}
        tree_manifest_path = folder / "licensed-tree.manifest.json"
        if sha256_file(tree_manifest_path) != report["licensed_manifest_sha256"]:
            raise ValueError(f"licensed tree manifest mismatch: {name}")
        tree = folder / "tree"
        validated = validate_manifest(tree_manifest_path, root=tree)
        if validated.get("source_name") != name or validated.get("source_revision") != report["revision"]:
            raise ValueError(f"licensed tree identity mismatch: {name}")
        for item in validated["files"]:
            license_file_index[(name, item["path"])] = item
        source_inputs[name] = {
            "revision": report["revision"],
            "raw_manifest_sha256": report["raw_manifest_sha256"],
            "licensed_manifest_sha256": report["licensed_manifest_sha256"],
        }
    return {"names": names, "raw_shards": raw_shard_index,
            "license_files": license_file_index, "source_inputs": source_inputs,
            "rights": registry, "rights_sha256": sha256_file(rights_path),
            "evidence_sha256": sha256_file(evidence_path),
            "git_lock_sha256": sha256_file(git_lock_path),
            "source_lock_sha256": sha256_file(source_lock_path)}


def build_package(input_root: Path, output: Path, *, forge_root: Path,
                  tokenizer_path: Path, seed: str, benchmark_plan: Path,
                  benchmark_root: Path, config_path: Path = DEFAULT_CONFIG) -> dict:
    started = time.monotonic()
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["RAYON_NUM_THREADS"] = "2"
    os.environ["OMP_NUM_THREADS"] = "2"
    os.environ["MKL_NUM_THREADS"] = "2"
    if output.exists():
        raise FileExistsError(f"output already exists: {output}")
    input_resolved, output_resolved = input_root.resolve(), output.resolve()
    if input_resolved == output_resolved or input_resolved in output_resolved.parents:
        raise ValueError("package output must be outside the immutable source candidate")
    if not seed or len(seed) > 128:
        raise ValueError("seed must be a non-empty string of at most 128 characters")
    config = _load_json(config_path)
    if (config.get("format") != "ilaria-licensed-code-pilot-policy-v1" or
            config.get("split_policy") != SPLIT_POLICY or
            config.get("split_bucket_boundaries") != {"train_end": 80, "validation_end": 90} or
            config.get("benchmark_shingle_width") != 12 or
            config.get("minimum_tokens") != {"train": 10_000_000, "validation": 1_000_000, "sealed": 1_000_000} or
            config.get("sources") != ["freertos_kernel", "zephyr"] or
            config.get("resource_caps") != {"output_bytes": MAX_OUTPUT_BYTES,
                "rss_bytes": MAX_RSS_BYTES, "wall_seconds": MAX_SECONDS, "threads": 2}):
        raise ValueError("pilot policy is unsupported or weaker than the declared gates")
    candidate_dir = input_root / "unique-code"
    candidate_path = candidate_dir / "candidate.jsonl"
    aliases_path = candidate_dir / "file-aliases.jsonl"
    candidate_manifest_path = candidate_dir / "candidate-manifest.json"
    package_manifest_path = input_root / "package-manifest.json"
    candidate_manifest = _load_json(candidate_manifest_path)
    package = _load_json(package_manifest_path)
    if candidate_manifest.get("format") != "ilaria-exact-body-code-candidate-v1" or \
            candidate_manifest.get("production_dataset_approved") is not False or \
            candidate_manifest.get("training_performed") is not False:
        raise ValueError("unsupported or promoted candidate manifest")
    if sha256_file(package_manifest_path) != candidate_manifest.get("source_package_sha256"):
        raise ValueError("source package manifest hash mismatch")
    if sha256_file(candidate_path) != candidate_manifest.get("candidate_sha256") or \
            candidate_path.stat().st_size != candidate_manifest.get("candidate_bytes"):
        raise ValueError("candidate shard hash/size mismatch")
    if sha256_file(aliases_path) != candidate_manifest.get("aliases_sha256") or \
            aliases_path.stat().st_size != candidate_manifest.get("aliases_bytes"):
        raise ValueError("alias shard hash/size mismatch")
    if candidate_manifest.get("tokenizer_sha256") != package.get("tokenizer_sha256"):
        raise ValueError("candidate/source tokenizer pin mismatch")
    if sha256_file(tokenizer_path) != package.get("tokenizer_sha256"):
        raise ValueError("canonical tokenizer hash mismatch")
    gates = _validate_source_gates(input_root, forge_root, package, candidate_manifest)

    sys.path.insert(0, str(forge_root))
    from hf_tokenizer import EOS, load, tokenizer_sha256
    from data_audit import benchmark_shingles, document_sha256, shingle_hashes
    from benchmark_exclusion_plan import load_plan, assess_plan
    tokenizer = load(str(tokenizer_path))
    eos_id = tokenizer.token_to_id(EOS)
    if eos_id is None or eos_id != package.get("eos_id"):
        raise ValueError("IlariaLex EOS mismatch")
    benchmark_plan_obj = load_plan(benchmark_plan)
    canonical_plan = forge_root / "config" / "imc_125m_benchmark_exclusions.json"
    if sha256_file(benchmark_plan) != sha256_file(canonical_plan):
        raise ValueError("benchmark plan differs from the pinned canonical exclusion plan")
    assessment = assess_plan(benchmark_plan, workspace_root=benchmark_root)
    if not assessment["ready"]:
        raise ValueError("frozen benchmark exclusion plan has missing/unsafe inputs")
    benchmark_files = assessment["files"]
    benchmark_set, benchmark_records = benchmark_shingles(benchmark_files, 12)

    # Alias bindings must resolve to canonical licensed file records, locked
    # source revisions and exact physical raw shard lines.
    aliases_by_body: dict[str, list[dict]] = defaultdict(list)
    aliases_by_raw_line: dict[tuple[str, str, int], dict] = {}
    aliases_seen = set()
    primary_counts = Counter()
    alias_count = 0
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "licensed_os_code_acquisition"))
    from dedup_candidate import body_bytes
    with aliases_path.open(encoding="utf-8") as stream:
        for line_no, line in enumerate(stream, 1):
            _check_time(started)
            if not line.strip():
                raise ValueError(f"blank alias row: {line_no}")
            alias = json.loads(line)
            if alias.get("source") not in gates["names"]:
                raise ValueError("alias has unknown source")
            report_source = alias["source"]
            expected_revision = gates["source_inputs"][report_source]["revision"]
            if alias.get("revision") != expected_revision:
                raise ValueError("alias revision is not source-lock pinned")
            shard = gates["raw_shards"].get((report_source, alias.get("raw_shard_sha256")))
            if not shard or type(alias.get("raw_line")) is not int or not 1 <= alias["raw_line"] <= shard["documents"]:
                raise ValueError("alias raw shard/line binding is invalid")
            licensed = gates["license_files"].get((report_source, alias.get("path")))
            if not licensed or licensed.get("sha256") != alias.get("file_sha256") or licensed.get("spdx") != alias.get("spdx"):
                raise ValueError("alias file hash/SPDX is not in the validated licensed tree")
            identity = (alias["source"], alias["revision"], alias["path"],
                        alias["spdx"], alias["file_sha256"], alias["raw_shard_sha256"], alias["raw_line"])
            if identity in aliases_seen:
                raise ValueError("duplicate alias provenance binding")
            aliases_seen.add(identity)
            raw_key = (alias["source"], alias["raw_shard_sha256"], alias["raw_line"])
            if raw_key in aliases_by_raw_line:
                raise ValueError("duplicate raw shard/line alias binding")
            aliases_by_raw_line[raw_key] = alias
            if not isinstance(alias.get("body_byte_sha256"), str) or len(alias["body_byte_sha256"]) != 64:
                raise ValueError("invalid alias body digest")
            aliases_by_body[alias["body_byte_sha256"]].append(alias)
            if alias.get("duplicate_body") is False:
                primary_counts[alias["body_byte_sha256"]] += 1
            alias_count += 1
            if alias_count % 256 == 0:
                _check_rss()
    if not aliases_by_body or any(primary_counts[digest] != 1 for digest in aliases_by_body):
        raise ValueError("each exact body must have exactly one retained primary alias")
    if alias_count != package.get("documents") or len(aliases_by_body) != candidate_manifest.get("unique_body_documents"):
        raise ValueError("candidate/alias accounting differs from source package manifests")
    body_groups = group_components([alias for rows in aliases_by_body.values() for alias in rows])

    # Resolve provenance to exact licensed raw records, including body bytes.
    # Reads are sequential; repository source code is never executed.
    for (source_name, shard_sha), shard in sorted(gates["raw_shards"].items()):
        with shard["path"].open(encoding="utf-8") as raw_stream:
            physical_lines = 0
            for raw_line, raw_text in enumerate(raw_stream, 1):
                _check_time(started)
                physical_lines = raw_line
                alias = aliases_by_raw_line.get((source_name, shard_sha, raw_line))
                if alias is None:
                    continue
                raw_record = json.loads(raw_text)
                if not isinstance(raw_record, dict):
                    raise ValueError("raw provenance line is not an object")
                if (raw_record.get("path"), raw_record.get("spdx"), raw_record.get("file_sha256")) != (
                        alias["path"], alias["spdx"], alias["file_sha256"]):
                    raise ValueError("raw line metadata does not match alias provenance")
                if hashlib.sha256(body_bytes(raw_record)).hexdigest() != alias["body_byte_sha256"]:
                    raise ValueError("raw line body differs from its alias digest")
            if physical_lines != shard["documents"]:
                raise ValueError("raw shard physical line count differs from manifest documents")

    output.mkdir(parents=True, exist_ok=False)
    split_paths = {split: output / f"{split}.jsonl" for split in SPLITS}
    docs = Counter()
    tokens = Counter()
    group_docs = Counter()
    group_tokens = Counter()
    contaminated = 0
    candidate_digests = set()
    streams = {name: path.open("xb") for name, path in split_paths.items()}
    try:
        with candidate_path.open(encoding="utf-8") as source:
            for line_no, line in enumerate(source, 1):
                _check_time(started)
                if line_no % 128 == 0:
                    _check_rss()
                row = json.loads(line)
                if row.get("schema") != "ilaria-source-qualified-code-candidate-v1" or row.get("duplicate_body") is not False:
                    raise ValueError("unsupported/non-primary candidate row")
                digest = row.get("body_byte_sha256")
                if digest in candidate_digests:
                    raise ValueError("duplicate candidate body row")
                candidate_digests.add(digest)
                if hashlib.sha256(body_bytes(row)).hexdigest() != digest:
                    raise ValueError("candidate body digest mismatch")
                token_count = len(tokenizer.encode(row["text"], add_special_tokens=False).ids) + 1
                if token_count != row.get("tokens_including_eos"):
                    raise ValueError("candidate diagnostic token count differs from frozen IlariaLex")
                aliases = aliases_by_body.get(digest)
                if not aliases:
                    raise ValueError("candidate has no alias provenance")
                primary = [a for a in aliases if a.get("duplicate_body") is False]
                if len(primary) != 1 or any(primary[0].get(k) != row.get(k) for k in
                        ("source", "revision", "path", "spdx", "file_sha256", "raw_shard_sha256", "raw_line")):
                    raise ValueError("candidate does not match its retained alias row")
                group = body_groups[digest]
                split = split_for_group(group, seed)
                if shingle_hashes(row["text"], 12) & benchmark_set:
                    contaminated += 1
                    continue
                record = {
                    "schema": "ilaria-licensed-code-scale-validation-row-v1",
                    "text": row["text"],
                    "source_group": group,
                    "split": split,
                    "body_byte_sha256": digest,
                    "document_sha256": document_sha256(row["text"]),
                    "source_provenance": sorted(({
                        "source": a["source"], "revision": a["revision"],
                        "path": a["path"], "spdx": a["spdx"],
                        "file_sha256": a["file_sha256"],
                        "raw_shard_sha256": a["raw_shard_sha256"],
                        "raw_line": a["raw_line"],
                        "exact_body_alias": True,
                    } for a in aliases), key=lambda v: (v["source"], v["path"], v["raw_line"])),
                    "tokens_including_eos": token_count,
                }
                streams[split].write((json.dumps(record, ensure_ascii=False,
                    sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8"))
                docs[split] += 1
                tokens[split] += token_count
                group_docs[group] += 1
                group_tokens[group] += token_count
                if docs[split] % 128 == 0:
                    _check_output_size(output)
    finally:
        for stream in streams.values():
            stream.flush()
            os.fsync(stream.fileno())
            stream.close()
    if candidate_digests != set(aliases_by_body):
        raise ValueError("candidate and alias body sets differ")
    minima = config["minimum_tokens"]
    if any(tokens[split] < minima[split] for split in SPLITS):
        raise ValueError(f"grouped split is below the configured per-split token minimum: {dict(tokens)}")
    _check_output_size(output)

    from hf_tokenizer import encode_jsonl
    stream_metadata = {}
    for split in SPLITS:
        _check_time(started)
        prefix = output / f"{split}.tokens"
        stream_metadata[split] = encode_jsonl(tokenizer, str(split_paths[split]),
                                              str(prefix), str(tokenizer_path))
        if stream_metadata[split]["tokens"] != tokens[split]:
            raise ValueError(f"canonical encoded token count mismatch: {split}")
        _check_output_size(output)

    sources = {name: gates["source_inputs"][name] for name in gates["names"]}
    manifest = {
        "format": FORMAT, "status": STATUS,
        "production_dataset_approved": False,
        "full_8_lane_quota_satisfied": False,
        "training_performed": False,
        "scope": "two-source code-only scale-validation; not a production mixture",
        "split_policy": SPLIT_POLICY, "seed": seed,
        "policy_sha256": sha256_file(config_path),
        "split_buckets": {"train": "00-79", "validation": "80-89", "sealed": "90-99"},
        "minimum_tokens": minima,
        "grouping": "source+locked-revision+repository-module-prefix; exact-body aliases union connected module groups",
        "benchmark_policy": "canonical frozen benchmark-exclusion plan; 12-word NFKC-casefold shingles",
        "benchmark_plan_sha256": benchmark_plan_obj["plan_sha256"],
        "benchmark_plan_file_sha256": sha256_file(benchmark_plan),
        "benchmark_root": "read-only canonical workspace root",
        "benchmark_files": benchmark_records,
        "benchmark_contaminated_documents_excluded": contaminated,
        "source_package_sha256": sha256_file(package_manifest_path),
        "source_candidate_manifest_sha256": sha256_file(candidate_manifest_path),
        "candidate_sha256": sha256_file(candidate_path),
        "aliases_sha256": sha256_file(aliases_path),
        "tokenizer_sha256": tokenizer_sha256(str(tokenizer_path)),
        "eos_token": EOS, "eos_id": eos_id,
        "rights_registry_sha256": gates["rights_sha256"],
        "rights_evidence_sha256": gates["evidence_sha256"],
        "git_source_lock_sha256": gates["git_lock_sha256"],
        "corpus_source_lock_sha256": gates["source_lock_sha256"],
        "sources": sources,
        "counts": {split: {"documents": docs[split], "tokens_including_eos": tokens[split],
                            "jsonl_sha256": sha256_file(split_paths[split]),
                            "jsonl_bytes": split_paths[split].stat().st_size,
                            "stream_sha256": stream_metadata[split]["stream_sha256"],
                            "stream_bytes": (output / f"{split}.tokens.bin").stat().st_size,
                            "stream_metadata_sha256": sha256_file(output / f"{split}.tokens.json"),
                            "stream_metadata_bytes": (output / f"{split}.tokens.json").stat().st_size}
                   for split in SPLITS},
        "group_counts": {"groups": len(group_docs),
                         "largest_group_documents": max(group_docs.values()),
                         "largest_group_tokens": max(group_tokens.values()),
                         "largest_group_document_fraction_ppm":
                             (max(group_docs.values()) * 1_000_000) // sum(group_docs.values()),
                         "split_group_counts": {split: len({group for group in group_docs
                             if split_for_group(group, seed) == split}) for split in SPLITS}},
        "input_counts": {"unique_candidate_documents": len(candidate_digests),
                         "alias_records": alias_count},
        "limits": {"max_output_bytes": MAX_OUTPUT_BYTES, "max_rss_bytes": MAX_RSS_BYTES,
                   "max_wall_seconds": MAX_SECONDS, "threads": 2},
        "elapsed_seconds": round(time.monotonic() - started, 2),
    }
    manifest["package_sha256"] = canonical_json_sha256(manifest)
    _write_json_new(output / "code-only-pilot-package.json", manifest)
    validate_package_manifest(output)
    _check_output_size(output)
    _check_time(started)
    return manifest


def _check_output_size(output: Path) -> None:
    total = sum(path.stat().st_size for path in output.rglob("*") if path.is_file())
    if total > MAX_OUTPUT_BYTES:
        raise ValueError("1 GiB output disk cap exceeded")


def _write_json_new(path: Path, value: dict) -> None:
    payload = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    with path.open("xb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--forge-root", type=Path, default=Path(__file__).resolve().parents[2] / "forge")
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--benchmark-plan", type=Path,
        default=Path(__file__).resolve().parents[2] / "forge" / "config" / "imc_125m_benchmark_exclusions.json")
    parser.add_argument("--benchmark-root", type=Path, required=True)
    parser.add_argument("--seed", default="licensed-os-code-scale-20261002-v1")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    args = parser.parse_args()
    result = build_package(args.input_root, args.output, forge_root=args.forge_root,
                           tokenizer_path=args.tokenizer, seed=args.seed,
                           benchmark_plan=args.benchmark_plan,
                           benchmark_root=args.benchmark_root, config_path=args.config)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
