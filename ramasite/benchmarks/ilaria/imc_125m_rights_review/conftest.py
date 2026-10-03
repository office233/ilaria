"""pytest configuration for the Nemotron rights-review helpers.

``test_nemotron_style_loading.py`` is an inspection script, not a test module:
it defines no tests and loads the locally reviewed Nemotron parquet shards at
import time. Collecting it therefore fails wherever those shards (or the
optional ``datasets`` package) are absent. It stays runnable as a script, but
pytest must never import it.
"""

collect_ignore = ["test_nemotron_style_loading.py"]
