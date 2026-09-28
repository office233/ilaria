"""Publish one checkpoint without truncating the previous successful file.

The temporary file lives beside the destination so os.replace does not cross
filesystems. The file is flushed and fsynced before publication. This is not a
multi-file transaction or a power-loss durability guarantee for every filesystem;
the parent directory is not fsynced. A hard kill can leave an unused .tmp file.
Writers to the same path must be serialized by the caller (last replacement wins).
"""
from __future__ import annotations

from contextlib import contextmanager
import os
from pathlib import Path
import tempfile
from typing import BinaryIO, Iterator


@contextmanager
def atomic_binary_writer(path: str | os.PathLike[str]) -> Iterator[BinaryIO]:
    """Yield a private binary file, replacing path only after successful close.

    The destination's parent must already exist. New checkpoints have the private
    permissions supplied by tempfile.mkstemp, including when replacing a file.
    Serialization, flush, fsync and replace errors propagate to the caller.
    """
    destination = Path(path)
    fd, temporary = tempfile.mkstemp(
        prefix=f'.{destination.name}.', suffix='.tmp', dir=destination.parent)
    try:
        stream = os.fdopen(fd, 'wb')
    except BaseException:
        os.close(fd)
        Path(temporary).unlink(missing_ok=True)
        raise
    try:
        with stream:
            yield stream
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        Path(temporary).unlink(missing_ok=True)
