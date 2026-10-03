"""Malformed content identities fail before an artifact can enter the pipeline."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from data_contract import require_lower_sha256  # noqa: E402


@pytest.mark.parametrize("value", [None, 123, "A" * 64, "g" * 64, "ab" * 31 + "  ", " " * 64])
def test_sha256_contract_rejects_nonhex_and_whitespace(value):
    with pytest.raises(ValueError, match="lowercase SHA-256"):
        require_lower_sha256("identity", value)


def test_sha256_contract_accepts_exactly_32_bytes_of_lowercase_hex():
    require_lower_sha256("identity", "0123456789abcdef" * 4)
