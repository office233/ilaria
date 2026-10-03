from datasets import load_dataset
REV="4b506f297762367fb05cac773fa41af672482160"
for style in ["DEBATE","INTERVIEW","LAYMAN_KNOWALL","PROBLEM_SOLVING","TEACHER_STUDENT","TWO_PROFESSORS","TWO_STUDENTS"]:
    ds = load_dataset(
        "nvidia/Nemotron-MIND",
        data_files={"train": f"{style}/*.parquet"},
        revision=REV,
        split="train",
        streaming=True,
    )
    row = next(iter(ds))
    print(style, row.get("Conversational Style"), row.get("Document ID"), len(row.get("Text","")))
