"""Standalone corrected continuation; requires the existing v3 adapter in Drive."""
import ast
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
p = root / "forge/colab"
old = json.loads((p / "Ilaria_SwypikOS_H100_Pilot.ipynb").read_text(encoding="utf-8"))
bundle = old["cells"][3]["source"]
if isinstance(bundle, list):
    bundle = "".join(bundle)
sources = ast.literal_eval(ast.parse(bundle).body[0].value)
sources = {name: (root / name).read_text(encoding="utf-8") for name in sources}
prompt = subprocess.check_output(["go", "run", "./cmd/ilaria-serve", "-print-system-prompt"], cwd=root).decode().strip()
source = "SOURCES = " + repr(sources) + "\nSYSTEM_PROMPT = " + repr(prompt) + "\n" + bundle[bundle.index('WORK = Path'):]

def code(text):
    ast.parse(text)
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": text}

data = (p / "grounding-v3-run.py").read_text(encoding="utf-8").split("RUN_V3 =", 1)[0]
data = 'sys.path.insert(0, str(WORK))\nfrom forge.tool_data import load_trajectories, validate_splits\n' + data
data += '\nRUN_V3 = ROOT / "runs/grounding-v3-250steps"\n'
old["cells"] = [
    {"cell_type": "markdown", "metadata": {}, "source": "# Ilaria aligned v4\nCorrected assistant generation-prefix tokenization. Requires v3 step250 in Drive. Run individually. Existing output is protected; exact resume requires the same encoding version. This is an experimental English adapter, not a production deployment."},
    old["cells"][1], old["cells"][2], code(source),
    code('from google.colab import drive\ndrive.mount("/content/drive")\nROOT = Path("/content/drive/MyDrive/ilaria/swypikos-en")'),
    old["cells"][10], code(data), code((p / "aligned-v4-run.py").read_text(encoding="utf-8")),
    code((p / "aligned-v4-verify.py").read_text(encoding="utf-8")),
]
(p / "Ilaria_Aligned_V4.ipynb").write_text(json.dumps(old, indent=2), encoding="utf-8")
print("Corrected standalone notebook saved")
