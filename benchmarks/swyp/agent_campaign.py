"""Run explicitly requested Antigravity tests in isolated source snapshots.

No permission overrides or installs. Stop new launches on quota/auth failures.
Agent reports are proposals; test outcomes must be independently reviewed.
"""
import concurrent.futures
import datetime
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
LAUNCHER = Path.home()/".codex/skills/antigravity/scripts/Invoke-Antigravity.ps1"
MODEL = "gemini-3.8-flash-high"
TOPICS = [
    "signed zero and exact float64 equality",
    "subnormal and very small finite numeric constants",
    "overflow and finite intermediate arithmetic",
    "rounding and observational deduplication",
    "candidate budget edges and duplicate constants",
    "node bounds and deterministic search ordering",
    "context cancellation and deadlines",
    "contradictory examples and exhausted versus impossible",
    "example and constant validation boundaries",
    "generated source parity with the Swyp interpreter on training and held-out inputs",
]

def main():
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    base = ROOT/"agent-lab"/stamp
    base.mkdir(parents=True, exist_ok=False)
    stop = threading.Event()
    lock = threading.Lock()
    rows = []
    sources = [ROOT/"go.mod"]
    for package in ("synthesis", "swyplang"):
        sources += [p for p in (ROOT/"internal"/package).glob("*.go")
                    if not p.name.endswith("_test.go")]
    hashes = {str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sources}
    for number in range(101):
        name = "research" if number == 0 else f"test-{number:03}"
        directory = base/name
        directory.mkdir()
        for source in sources:
            destination = directory/source.relative_to(ROOT)
            destination.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(source,destination)
        (directory/"AGENTS.md").write_text(
            "Work only in this isolated snapshot. Do not edit original project or settings.\n"
            "No network, processes or filesystem access from generated test code.\n"
            "No installs or dependencies. Tests may import the Go standard library and local packages.\n"
            "Production source is read-only. Write only your assigned test/report.\n",encoding="utf-8")
        if number == 0:
            prompt = (
                "Research task: read internal/synthesis/synthesis.go and propose one technically credible "
                "non-LLM improvement beyond example matching: finite-domain contracts, counterexamples, "
                "or typed holes. Write RESEARCH.md only, <=100 lines. Distinguish prior art from novel "
                "hypotheses; do not claim invention without evidence. Cite precise primary source URLs "
                "if accessible, otherwise mark them unverified. No implementation or test execution. "
                "Compare benefits and failure modes under float64, and give 3 acceptance tests.")
        else:
            topic = TOPICS[(number-1)//10]
            prompt = (
                f"You are test agent {number:03}, reproducible seed {number}, focus: {topic}. "
                "Read internal/synthesis/synthesis.go (and interpreter only if needed). "
                "Write internal/synthesis/agent_test.go, package synthesis_test, at most 100 lines, "
                "with 1-3 meaningful edge-case/property tests specific to this focus and seed. "
                "Use public synthesis.Synthesize API. Check errors and budgets; never require "
                "generalization from underspecified examples. Run go test ./internal/synthesis "
                "-run Agent -count=1 -timeout=15s. Name all tests TestAgent... . "
                "Write REPORT.md <=30 lines with actual command outcome, reproducible finding and "
                "suggested fix if needed. Do not change production or other files, install tools, "
                "run full-project suites, or claim unrun tests passed. On permission denial, "
                "return the test/report text without bypassing permissions. Keep work small.")
        (directory/"TASK.txt").write_text(prompt,encoding="utf-8")
        rows.append(dict(agent=name,number=number,status="queued",directory=str(directory)))

    def save():
        report = dict(model=MODEL,parallelism=8,requested_test_agents=100,
                      requested_research_agents=1,source_sha256=hashes,agents=rows)
        temp=base/"status.tmp"
        temp.write_text(json.dumps(report,indent=2),encoding="utf-8")
        temp.replace(base/"status.json")

    save()
    print(f"CAMPAIGN {base}",flush=True)
    def worker(row):
        directory=Path(row["directory"])
        with lock:
            if stop.is_set():
                row["status"]="not_launched_after_provider_block"
                save()
                return
            row["status"]="running"
            save()
        start=time.monotonic()
        command=[shutil.which("pwsh"),"-NoProfile","-File",str(LAUNCHER),
                 "--model",MODEL,"--dir",str(directory),"--timeout","120s",
                 "--digest",(directory/"TASK.txt").read_text(encoding="utf-8")]
        try:
            with (directory/"stdout.txt").open("w",encoding="utf-8") as out, \
                 (directory/"stderr.txt").open("w",encoding="utf-8") as err:
                process=subprocess.Popen(command,cwd=directory,stdout=out,stderr=err)
                # Delegate enforces its timeout; keep diagnostics until it exits.
                code=process.wait()
            diagnostics=(directory/"stderr.txt").read_text(encoding="utf-8")
            blocked=(code in (10,11,13,14) or any(marker in diagnostics for marker in
                     ('"status":"QUOTA','"status":"AUTH','"status": "QUOTA',
                      '"status": "AUTH','"status":"MODEL_UNAVAILABLE')))
            with lock:
                row.update(status="completed" if code==0 else "failed_or_partial",
                           exit_code=code,seconds=round(time.monotonic()-start,2),
                           test_file=(directory/"internal/synthesis/agent_test.go").exists(),
                           report_file=(directory/("RESEARCH.md" if row["number"]==0 else "REPORT.md")).exists())
                if blocked:
                    stop.set()
                    row["provider_block"]=True
                save()
        except Exception as exc:
            with lock:
                row.update(status="runner_error",error=str(exc))
                stop.set()
                save()
        print(f'{row["agent"]}: {row["status"]}',flush=True)

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(worker,rows))
    print(f"FINISHED {base/'status.json'}",flush=True)

if __name__=="__main__":
    main()
