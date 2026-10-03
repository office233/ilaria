"""IlariaLex byte-level BPE tokenizer.

Canonical production layout:
    0 .. 61_439     learned byte-level BPE vocabulary
    61_440 .. 65_535 protocol-reserved special tokens

The 4,096 protocol IDs are appended *after* BPE training so their numeric
identities are deterministic and independent of corpus composition. Once
IMC-1B Genesis starts, this layout is immutable.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

import numpy as np

try:
    from .atomic_io import atomic_binary_writer
except ImportError:  # direct script execution
    from atomic_io import atomic_binary_writer

ILARIALEX_FORMAT = "ilarialex-v1"
ILARIALEX_VOCAB_SIZE = 65_536
ILARIALEX_PROTOCOL_RESERVED = 4_096
ILARIALEX_BASE_VOCAB_SIZE = ILARIALEX_VOCAB_SIZE - ILARIALEX_PROTOCOL_RESERVED

EOS = "<|ilaria:eos|>"
BOS = "<|ilaria:bos|>"
PAD = "<|ilaria:pad|>"

_CORE_PROTOCOL_TOKENS = [
    EOS,
    BOS,
    PAD,
    "<|role:system|>",
    "<|role:user|>",
    "<|role:assistant|>",
    "<|action:read|>",
    "<|action:write|>",
    "<|action:execute|>",
    "<|action:probe|>",
    "<|action:verify|>",
    "<|obs:result|>",
    "<|obs:error|>",
    "<|verify:pass|>",
    "<|verify:fail|>",
    "<|device:pc|>",
    "<|device:phone|>",
    "<|device:vehicle|>",
    "<|device:embedded|>",
    "<|device:robot|>",
    "<|bus:obd2|>",
    "<|bus:can|>",
    "<|bus:pci|>",
    "<|bus:usb|>",
    "<|bus:acpi|>",
    "<|bus:devicetree|>",
    "<|sensor:rpm|>",
    "<|sensor:speed|>",
    "<|sensor:temperature|>",
    "<|sensor:voltage|>",
    "<|sensor:accelerometer|>",
    "<|sensor:gyroscope|>",
    "<|sensor:battery|>",
    "<|state:charging|>",
    "<|state:idle|>",
    "<|privacy:public|>",
    "<|privacy:curated|>",
    "<|privacy:device_nonpersonal|>",
    "<|privacy:local_private|>",
    "<|privacy:sensitive|>",
    "<|result:verified|>",
    "<|result:rejected|>",
    "<|pce:start|>",
    "<|pce:end|>",
    "<|world:start|>",
    "<|world:end|>",
]


def protocol_tokens(count: int = ILARIALEX_PROTOCOL_RESERVED) -> list[str]:
    """Return the deterministic protocol-token suffix."""
    if count < len(_CORE_PROTOCOL_TOKENS):
        raise ValueError(
            f"protocol reserve {count} is smaller than the "
            f"{len(_CORE_PROTOCOL_TOKENS)} required core tokens"
        )
    out = list(_CORE_PROTOCOL_TOKENS)
    for i in range(count - len(out)):
        out.append(f"<|ilaria:reserved:{i:04d}|>")
    if len(out) != len(set(out)):
        raise AssertionError("IlariaLex protocol token list contains duplicates")
    return out


def _hf():
    try:
        from tokenizers import (
            Tokenizer,
            decoders,
            models,
            pre_tokenizers,
            processors,
            trainers,
        )
    except ImportError:
        sys.exit("pip install tokenizers")
    return Tokenizer, decoders, models, pre_tokenizers, processors, trainers


def build_tokenizer():
    Tokenizer, decoders, models, pre_tokenizers, processors, _ = _hf()
    tok = Tokenizer(models.BPE(unk_token=None))
    tok.pre_tokenizer = pre_tokenizers.ByteLevel(
        add_prefix_space=False, use_regex=True
    )
    tok.decoder = decoders.ByteLevel()
    tok.post_processor = processors.ByteLevel(trim_offsets=False)
    return tok


def _validate_layout(vocab_size: int, protocol_reserve: int) -> int:
    if vocab_size < 512:
        raise ValueError("vocab_size must be at least 512 for byte-level BPE")
    if protocol_reserve < len(_CORE_PROTOCOL_TOKENS):
        raise ValueError(
            f"protocol_reserve must be at least {len(_CORE_PROTOCOL_TOKENS)}"
        )
    if protocol_reserve >= vocab_size - 256:
        raise ValueError(
            "protocol_reserve leaves insufficient room for the byte alphabet"
        )
    if vocab_size > 2**32:
        raise ValueError("vocab_size exceeds uint32 token-stream capacity")
    return vocab_size - protocol_reserve


def train(
    input_paths,
    vocab_size: int,
    out_path: str,
    min_frequency: int = 2,
    protocol_reserve: int | None = None,
):
    """Train learned BPE tokens, then append a deterministic protocol suffix."""
    if protocol_reserve is None:
        protocol_reserve = (
            ILARIALEX_PROTOCOL_RESERVED
            if vocab_size == ILARIALEX_VOCAB_SIZE
            else min(64, max(len(_CORE_PROTOCOL_TOKENS), vocab_size // 10))
        )
    base_vocab_size = _validate_layout(vocab_size, protocol_reserve)

    _, _, _, pre_tokenizers, _, trainers = _hf()
    tok = build_tokenizer()
    trainer = trainers.BpeTrainer(
        vocab_size=base_vocab_size,
        min_frequency=min_frequency,
        special_tokens=[],
        initial_alphabet=pre_tokenizers.ByteLevel.alphabet(),
        show_progress=False,
    )
    tok.train(list(input_paths), trainer)

    actual_base = tok.get_vocab_size()
    if actual_base != base_vocab_size:
        raise ValueError(
            f"training produced {actual_base} base tokens, "
            f"expected exactly {base_vocab_size}; provide a larger tokenizer corpus"
        )

    specials = protocol_tokens(protocol_reserve)
    added = tok.add_special_tokens(specials)
    if added != protocol_reserve:
        raise ValueError(
            f"added {added} protocol tokens, expected {protocol_reserve}; "
            "a protocol token collided with the learned vocabulary"
        )
    if tok.get_vocab_size() != vocab_size:
        raise AssertionError(
            f"final vocabulary is {tok.get_vocab_size()}, expected {vocab_size}"
        )

    for offset, token in enumerate(specials):
        got = tok.token_to_id(token)
        want = base_vocab_size + offset
        if got != want:
            raise ValueError(
                f"protocol token {token!r} has id {got}, expected {want}"
            )

    export_ilaria(tok, out_path, base_vocab_size, specials)
    hf_path = os.path.splitext(out_path)[0] + ".hf.json"
    tok.save(hf_path)
    print(
        f"[ilarialex] vocab {tok.get_vocab_size()} "
        f"(base {base_vocab_size} + protocol {protocol_reserve}) "
        f"-> {out_path} (+ {hf_path})"
    )
    return tok


def export_ilaria(
    tok, out_path: str, base_vocab_size: int, special_tokens: list[str]
) -> None:
    """Write the deterministic IlariaLex JSON contract."""
    vocab = tok.get_vocab()
    model = json.loads(tok.to_str())["model"]
    merges = []
    for merge in model["merges"]:
        if isinstance(merge, (list, tuple)):
            a, b = merge
        else:
            a, b = merge.split(" ", 1)
        merges.append({"a": a, "b": b})

    special_ids = [
        {"token": token, "id": tok.token_to_id(token)}
        for token in special_tokens
    ]
    data = {
        "format": ILARIALEX_FORMAT,
        "vocab_size": len(vocab),
        "base_vocab_size": base_vocab_size,
        "protocol_reserved": len(special_tokens),
        "protocol_start_id": base_vocab_size,
        "eos_token": EOS,
        "eos_id": tok.token_to_id(EOS),
        "bos_token": BOS,
        "bos_id": tok.token_to_id(BOS),
        "pad_token": PAD,
        "pad_id": tok.token_to_id(PAD),
        "special_tokens": special_ids,
        "merges": merges,
        "vocab": vocab,
        "byte_level": True,
    }
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as stream:
        json.dump(data, stream, ensure_ascii=False, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, out_path)


def _load_contract(tok_path: str) -> dict:
    with open(tok_path, encoding="utf-8") as stream:
        data = json.load(stream)
    required = {
        "format",
        "vocab_size",
        "base_vocab_size",
        "protocol_reserved",
        "protocol_start_id",
        "eos_token",
        "eos_id",
        "special_tokens",
        "merges",
        "vocab",
        "byte_level",
    }
    missing = required - set(data)
    if missing:
        raise ValueError(
            "IlariaLex tokenizer is missing fields: " + ", ".join(sorted(missing))
        )
    if data["format"] != ILARIALEX_FORMAT:
        raise ValueError(f"unsupported tokenizer format {data['format']!r}")
    if data["protocol_start_id"] != data["base_vocab_size"]:
        raise ValueError("protocol_start_id does not equal base_vocab_size")
    if data["vocab_size"] != len(data["vocab"]):
        raise ValueError("vocab_size does not match vocabulary length")
    if data["protocol_reserved"] != len(data["special_tokens"]):
        raise ValueError("protocol_reserved does not match special_tokens")
    return data


def load(tok_path: str):
    """Load and validate the canonical IlariaLex JSON contract."""
    data = _load_contract(tok_path)
    _, _, models, _, _, _ = _hf()

    protocol_start = int(data["protocol_start_id"])
    base_vocab = {
        token: token_id
        for token, token_id in data["vocab"].items()
        if int(token_id) < protocol_start
    }
    if len(base_vocab) != protocol_start:
        raise ValueError("base vocabulary IDs are not contiguous")

    tok = build_tokenizer()
    tok.model = models.BPE(
        vocab=base_vocab,
        merges=[(m["a"], m["b"]) for m in data["merges"]],
        unk_token=None,
    )
    specials = [entry["token"] for entry in data["special_tokens"]]
    added = tok.add_special_tokens(specials)
    if added != len(specials):
        raise ValueError("protocol special tokens collide with base vocabulary")

    for entry in data["special_tokens"]:
        if tok.token_to_id(entry["token"]) != int(entry["id"]):
            raise ValueError(
                f"protocol token id drift for {entry['token']!r}"
            )
    if tok.get_vocab_size() != int(data["vocab_size"]):
        raise ValueError("loaded vocabulary size differs from contract")
    if tok.token_to_id(data["eos_token"]) != int(data["eos_id"]):
        raise ValueError("EOS token id drift")
    return tok


def tokenizer_sha256(tok_path: str | os.PathLike[str]) -> str:
    h = hashlib.sha256()
    with open(tok_path, "rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def stream_dtype(vocab_size: int):
    if not 1 <= vocab_size <= 2**32:
        raise ValueError("vocab_size is outside supported token-stream range")
    return np.uint16 if vocab_size <= 65_536 else np.uint32


def encode_jsonl(tok, in_path: str, out_prefix: str, tok_name: str) -> dict:
    eos = tok.token_to_id(EOS)
    if eos is None:
        raise ValueError(f"tokenizer has no canonical EOS token {EOS!r}")
    vocab = tok.get_vocab_size()
    dtype = stream_dtype(vocab)
    docs = tokens = 0
    with open(in_path, encoding="utf-8") as source, atomic_binary_writer(
        out_prefix + ".bin"
    ) as out:
        buf = []
        for line_number, line in enumerate(source, 1):
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{in_path}:{line_number}: invalid JSON") from exc
            if not isinstance(record, dict):
                raise ValueError(f"{in_path}:{line_number}: expected JSON object")
            text = record.get("text", "")
            if not isinstance(text, str):
                raise ValueError(f"{in_path}:{line_number}: text must be a string")
            if not text:
                continue
            ids = tok.encode(text, add_special_tokens=False).ids
            buf.extend(ids)
            buf.append(eos)
            docs += 1
            tokens += len(ids) + 1
            if len(buf) >= 1 << 20:
                np.asarray(buf, dtype=dtype).tofile(out)
                buf = []
        if buf:
            np.asarray(buf, dtype=dtype).tofile(out)

    contract = _load_contract(tok_name)
    meta = {
        "format": "ilaria-token-stream-v1",
        "vocab_size": vocab,
        "eos_id": eos,
        "dtype": "uint16" if dtype is np.uint16 else "uint32",
        "tokens": tokens,
        "documents": docs,
        "stream_sha256": tokenizer_sha256(out_prefix + ".bin"),
        "tokenizer": str(Path(tok_name).name),
        "tokenizer_sha256": tokenizer_sha256(tok_name),
        "tokenizer_format": contract["format"],
        "protocol_start_id": contract["protocol_start_id"],
        "byte_level": True,
    }
    tmp = out_prefix + ".json.tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as stream:
        json.dump(meta, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, out_prefix + ".json")
    print(
        f"[ilarialex] {in_path}: {docs:,} docs -> {tokens:,} tokens "
        f"-> {out_prefix}.bin"
    )
    return meta


def main(argv=None):
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    train_parser = sub.add_parser("train")
    train_parser.add_argument("--input", action="append", required=True)
    train_parser.add_argument(
        "--vocab", type=int, default=ILARIALEX_VOCAB_SIZE
    )
    train_parser.add_argument(
        "--protocol-reserve",
        type=int,
        default=None,
        help=(
            "reserved protocol IDs; defaults to 4096 for the canonical "
            "65536 vocabulary"
        ),
    )
    train_parser.add_argument("--out", required=True)

    encode_parser = sub.add_parser("encode")
    encode_parser.add_argument("--tokenizer", required=True)
    encode_parser.add_argument("--in", dest="in_path", required=True)
    encode_parser.add_argument("--out", required=True)

    ids_parser = sub.add_parser("ids")
    ids_parser.add_argument("--tokenizer", required=True)

    args = parser.parse_args(argv)
    if args.cmd == "train":
        train(
            args.input,
            args.vocab,
            args.out,
            protocol_reserve=args.protocol_reserve,
        )
    elif args.cmd == "encode":
        encode_jsonl(
            load(args.tokenizer), args.in_path, args.out, args.tokenizer
        )
    else:
        tok = load(args.tokenizer)
        for line in sys.stdin:
            line = line.rstrip("\n")
            print(
                json.dumps(
                    tok.encode(line, add_special_tokens=False).ids
                )
            )


if __name__ == "__main__":
    main()
