from __future__ import annotations

import json
import subprocess

import pytest

from data_contract import atomic_write_json
from git_source_checkout import checkout_locked_source
from git_source_lock import build_lock


def lock_fixture(tmp_path):
    lock = build_lock(
        {
            "source_a": {
                "url": "https://github.com/example/source-a.git",
                "ref": "main",
                "commit": "a" * 40,
            }
        }
    )
    path = tmp_path / "lock.json"
    atomic_write_json(path, lock)
    return path, lock


def fake_runner_factory(*, head="a" * 40, remote="https://github.com/example/source-a.git"):
    calls = []
    kwargs_seen = []

    def runner(args, **kwargs):
        calls.append(args)
        kwargs_seen.append(kwargs)
        stdout = ""
        if args[-2:] == ["rev-parse", "HEAD"]:
            stdout = head + "\n"
        elif args[-3:] == ["remote", "get-url", "origin"]:
            stdout = remote + "\n"
        return subprocess.CompletedProcess(args=args, returncode=0, stdout=stdout, stderr="")

    return runner, calls, kwargs_seen


def test_checkout_uses_locked_commit_and_never_initializes_submodules(tmp_path):
    lock_path, lock = lock_fixture(tmp_path)
    runner, calls, kwargs_seen = fake_runner_factory()
    report = checkout_locked_source(
        lock_path,
        source_name="source_a",
        destination=tmp_path / "checkout",
        runner=runner,
    )
    assert report["commit"] == lock["sources"]["source_a"]["commit"]
    flattened = [item for call in calls for item in call]
    assert "submodule" not in flattened
    assert lock["sources"]["source_a"]["commit"] in flattened
    assert {call["timeout"] for call in kwargs_seen} == {1800}


def test_checkout_rejects_nonempty_destination_before_git(tmp_path):
    lock_path, _ = lock_fixture(tmp_path)
    out = tmp_path / "checkout"
    out.mkdir()
    (out / "existing.txt").write_text("do not overwrite", encoding="utf-8")
    runner, calls, _ = fake_runner_factory()
    with pytest.raises(ValueError, match="not empty"):
        checkout_locked_source(
            lock_path,
            source_name="source_a",
            destination=out,
            runner=runner,
        )
    assert calls == []


def test_checkout_fails_closed_on_commit_mismatch_and_removes_partial_tree(tmp_path):
    lock_path, _ = lock_fixture(tmp_path)
    out = tmp_path / "checkout"
    runner, _, _ = fake_runner_factory(head="b" * 40)
    with pytest.raises(ValueError, match="differs from lock"):
        checkout_locked_source(
            lock_path,
            source_name="source_a",
            destination=out,
            runner=runner,
        )
    assert not out.exists()


def test_checkout_fails_closed_on_remote_mismatch(tmp_path):
    lock_path, _ = lock_fixture(tmp_path)
    out = tmp_path / "checkout"
    runner, _, _ = fake_runner_factory(remote="https://github.com/evil/repo.git")
    with pytest.raises(ValueError, match="remote differs from lock"):
        checkout_locked_source(
            lock_path,
            source_name="source_a",
            destination=out,
            runner=runner,
        )
    assert not out.exists()


def test_checkout_propagates_custom_command_timeout(tmp_path):
    lock_path, _ = lock_fixture(tmp_path)
    runner, _, kwargs_seen = fake_runner_factory()
    checkout_locked_source(
        lock_path,
        source_name="source_a",
        destination=tmp_path / "checkout",
        runner=runner,
        command_timeout_seconds=37,
    )
    assert {call["timeout"] for call in kwargs_seen} == {37}
