from __future__ import annotations

import json

import pytest

from git_source_lock import build_lock, validate_lock


def entries():
    return {
        "zephyr": {
            "url": "https://github.com/zephyrproject-rtos/zephyr.git",
            "ref": "main",
            "commit": "a" * 40,
        }
    }


def test_git_source_lock_is_deterministic_and_valid():
    one = build_lock(entries())
    two = build_lock(dict(reversed(list(entries().items()))))
    assert one == two
    assert validate_lock(one) == one


def test_git_source_lock_rejects_mutable_ref_as_commit():
    bad = entries()
    bad["zephyr"]["commit"] = "main"
    with pytest.raises(ValueError, match="40-hex"):
        build_lock(bad)


def test_git_source_lock_rejects_non_https_remote():
    bad = entries()
    bad["zephyr"]["url"] = "git@github.com:zephyrproject-rtos/zephyr.git"
    with pytest.raises(ValueError, match="https"):
        build_lock(bad)


def test_git_source_lock_detects_identity_tampering():
    lock = build_lock(entries())
    lock["sources"]["zephyr"]["commit"] = "b" * 40
    with pytest.raises(ValueError, match="identity hash mismatch"):
        validate_lock(lock)
