from huggingface_hub import HfApi
import json

info = HfApi().dataset_info("nvidia/Nemotron-MIND", revision="4b506f297762367fb05cac773fa41af672482160")
files = [s.rfilename for s in info.siblings if s.rfilename.endswith(".parquet")]
print(json.dumps({"count": len(files), "files": files[:300]}, indent=2))
