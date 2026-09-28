"""CPU-only audit regressions; no downloads or existing model files required."""
import copy
import importlib
import json
from argparse import Namespace
from pathlib import Path

import numpy as np
import pytest
import torch

import nxtf
import train_ilaria as train
from ilaria_model import IlariaConfig, IlariaTransformer


@pytest.fixture
def tiny_model():
    torch.manual_seed(17)
    return IlariaTransformer(IlariaConfig(
        vocab_size=16, embed_dim=8, num_heads=2, num_layers=1,
        ffn_dim=16, max_seq_len=8, dropout_rate=0.0))


def test_single_valid_window():
    x, y = train.batch_windows(np.arange(4), 3, 2, np.random.default_rng(7), 'cpu')
    assert x.tolist() == [[0, 1, 2], [0, 1, 2]]
    assert y.tolist() == [[1, 2, 3], [1, 2, 3]]
    assert x.dtype == y.dtype == torch.int64


def test_last_valid_window_is_reachable():
    class LastStart:
        def integers(self, low, high, size):
            assert low == 0
            return np.full(size, high - 1)
    x, y = train.batch_windows(np.arange(5), 3, 1, LastStart(), 'cpu')
    assert x.tolist() == [[1, 2, 3]]
    assert y.tolist() == [[2, 3, 4]]


def test_failed_export_preserves_previous_checkpoint(tmp_path, monkeypatch, tiny_model):
    path = tmp_path / 'transformer.nxtf'
    nxtf.save_nxtf(tiny_model, path)
    previous = path.read_bytes()
    def broken_tensors(_model):
        raise OSError('injected export failure')
    monkeypatch.setattr(nxtf, '_ordered_tensors', broken_tensors)
    with pytest.raises(OSError, match='injected'):
        nxtf.save_nxtf(tiny_model, path)
    assert path.read_bytes() == previous
    assert sorted(p.name for p in tmp_path.iterdir()) == ['transformer.nxtf']


def test_evaluation_preserves_eval_mode(tiny_model):
    tiny_model.eval()
    value = train.evaluate(tiny_model, np.arange(16), 3, 2, 'cpu', 1,
                           np.random.default_rng(3), None)
    assert np.isfinite(value)
    assert not tiny_model.training


@pytest.mark.parametrize('ctx,bsz,length', [(0, 1, 8), (-1, 1, 8), (3, 0, 8), (3, -1, 8), (3, 1, 3)])
def test_invalid_window_parameters(ctx, bsz, length):
    with pytest.raises(ValueError, match='positive|at least'):
        train.batch_windows(np.arange(length), ctx, bsz, np.random.default_rng(1), 'cpu')


def test_split_rejects_empty_training_data():
    with pytest.raises(ValueError, match='too short'):
        train.split_stream(np.arange(200), 4)


def test_split_minimum_valid_length_and_no_overlap():
    data = np.arange(205)
    training, validation = train.split_stream(data, 4)
    assert training.tolist() == [0, 1, 2, 3, 4]
    assert validation.tolist() == list(range(5, 205))
    assert np.shares_memory(training, data)
    assert np.shares_memory(validation, data)


def valid_args():
    return Namespace(ctx=4, max_seq_len=8, embed_dim=8, heads=2, layers=1,
                     ffn_dim=16, batch=2, accum=1, steps=2, eval_every=1,
                     eval_iters=1, rope=False, dropout=0.1, warmup=0, seed=42,
                     lr=0.001, min_lr=0.0001, wd=0.1)


@pytest.mark.parametrize('field,value', [('batch', 0), ('accum', 0), ('eval_every', 0),
    ('eval_iters', 0), ('ctx', 9), ('embed_dim', 7), ('dropout', 1.0),
    ('lr', float('nan')), ('min_lr', 0.002), ('wd', -1), ('seed', -1)])
def test_training_arguments_fail_early(field, value):
    args = valid_args()
    setattr(args, field, value)
    with pytest.raises(ValueError):
        train.validate_training_args(args)


def test_odd_rope_head_dimension_is_rejected():
    args = valid_args()
    args.embed_dim, args.rope = 6, True
    with pytest.raises(ValueError, match='even head'):
        train.validate_training_args(args)


def test_valid_training_arguments():
    train.validate_training_args(valid_args())


@pytest.mark.parametrize('dtype', ['uint16', 'uint32'])
def test_load_supported_token_streams(tmp_path, dtype):
    prefix = tmp_path / 'tokens'
    prefix.with_suffix('.json').write_text(json.dumps({'dtype': dtype, 'vocab_size': 16, 'eos_id': 3}))
    np.arange(12, dtype='<u2' if dtype == 'uint16' else '<u4').tofile(prefix.with_suffix('.bin'))
    data, _ = train.load_stream(str(prefix))
    assert data.tolist() == list(range(12))


def test_unknown_stream_dtype_is_not_silently_uint32(tmp_path):
    prefix = tmp_path / 'tokens'
    prefix.with_suffix('.json').write_text(json.dumps({'dtype': 'uint61'}))
    with pytest.raises(ValueError, match='unsupported'):
        train.load_stream(str(prefix))


def test_evaluation_restores_training_mode_on_exception(tiny_model, monkeypatch):
    tiny_model.train()
    def failure(*args, **kwargs):
        raise RuntimeError('injected forward failure')
    monkeypatch.setattr(tiny_model, 'forward', failure)
    with pytest.raises(RuntimeError, match='injected'):
        train.evaluate(tiny_model, np.arange(16), 3, 2, 'cpu', 1, np.random.default_rng(2), None)
    assert tiny_model.training


def test_evaluation_is_repeatable_with_fixed_validation_rng(tiny_model):
    training_rng = np.random.default_rng(42)
    before = copy.deepcopy(training_rng.bit_generator.state)
    values = [train.evaluate(tiny_model, np.arange(16), 3, 2, 'cpu', 2,
              np.random.default_rng(np.random.SeedSequence([42, 1])), None) for _ in range(2)]
    assert values[0] == values[1]
    assert training_rng.bit_generator.state == before


def test_zero_evaluation_iterations_rejected(tiny_model):
    with pytest.raises(ValueError, match='iterations'):
        train.evaluate(tiny_model, np.arange(16), 3, 2, 'cpu', 0, np.random.default_rng(2), None)


@pytest.mark.parametrize('rope,swiglu', [(False, False), (True, True)])
def test_nxtf_roundtrip_unchanged_bytes(tmp_path, rope, swiglu):
    model = IlariaTransformer(IlariaConfig(vocab_size=16, embed_dim=8, num_heads=2,
        num_layers=1, ffn_dim=16, max_seq_len=8, use_rope=rope, use_swiglu=swiglu))
    first, second = tmp_path / 'first.nxtf', tmp_path / 'second.nxtf'
    nxtf.save_nxtf(model, first)
    loaded = nxtf.load_nxtf(first)
    assert model.cfg == loaded.cfg
    for a, b in zip(model.parameters(), loaded.parameters()):
        assert torch.equal(a, b)
    nxtf.save_nxtf(loaded, second)
    assert first.read_bytes() == second.read_bytes()


def test_atomic_file_visible_only_after_success(tmp_path):
    from atomic_io import atomic_binary_writer
    path = tmp_path / 'checkpoint.pt'
    path.write_bytes(b'old')
    with atomic_binary_writer(path) as stream:
        stream.write(b'new')
        stream.flush()
        assert path.read_bytes() == b'old'
    assert path.read_bytes() == b'new'
    assert sorted(p.name for p in tmp_path.iterdir()) == ['checkpoint.pt']


@pytest.mark.parametrize('operation', ['replace', 'fsync'])
def test_atomic_publication_failure_preserves_previous_file(tmp_path, monkeypatch, operation):
    atomic_io = importlib.import_module('atomic_io')
    path = tmp_path / 'checkpoint.pt'
    path.write_bytes(b'old')
    def fail(*args, **kwargs):
        raise OSError('injected filesystem failure')
    monkeypatch.setattr(atomic_io.os, operation, fail)
    with pytest.raises(OSError, match='injected'):
        with atomic_io.atomic_binary_writer(path) as stream:
            stream.write(b'partial')
    assert path.read_bytes() == b'old'
    assert sorted(p.name for p in tmp_path.iterdir()) == ['checkpoint.pt']


def test_failed_first_export_leaves_no_destination(tmp_path, monkeypatch, tiny_model):
    path = tmp_path / 'transformer.nxtf'
    def fail(_):
        raise OSError('injected')
    monkeypatch.setattr(nxtf, '_ordered_tensors', fail)
    with pytest.raises(OSError):
        nxtf.save_nxtf(tiny_model, path)
    assert list(tmp_path.iterdir()) == []


def test_atomic_torch_checkpoint_roundtrip(tmp_path):
    from atomic_io import atomic_binary_writer
    path = tmp_path / 'checkpoint.pt'
    original = {'step': 2, 'weights': torch.arange(8, dtype=torch.float32)}
    with atomic_binary_writer(path) as stream:
        torch.save(original, stream)
    loaded = torch.load(path, weights_only=True)
    assert loaded['step'] == 2
    assert torch.equal(loaded['weights'], original['weights'])
