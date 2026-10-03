import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const workspaceRoot = process.cwd();

function hasCmd(cmd) {
  const probe = process.platform === "win32"
    ? spawnSync("where", [cmd], { stdio: "ignore", shell: false })
    : spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
  return probe.status === 0;
}

function canRunPython(command) {
  if (command.includes("\\") && !existsSync(command)) return false;
  const r = spawnSync(command, ["-m", "pytest", "--version"], { stdio: "ignore", shell: false });
  return r.status === 0;
}

const candidates = [
  process.env.PYTHON,
  join(workspaceRoot, ".venv", "Scripts", "python.exe"),
  join(workspaceRoot, ".venv", "bin", "python"),
  join(workspaceRoot, "workers", "video-worker", ".venv", "Scripts", "python.exe"),
  join(workspaceRoot, "workers", "video-worker", ".venv", "bin", "python"),
  join(workspaceRoot, "workers", "ai-worker", ".venv", "Scripts", "python.exe"),
  join(workspaceRoot, "workers", "ai-worker", ".venv", "bin", "python"),
  "python3",
  "python",
  "py",
].filter(Boolean);

const localPython = candidates.find(canRunPython);
const useDocker = !localPython && hasCmd("docker");

if (!localPython && !useDocker) {
  console.error(
    "Could not find Python with pytest and Docker is not available. " +
      "Create a local .venv with worker requirements, set PYTHON, or install Docker."
  );
  process.exit(1);
}

const tempRoot = join(workspaceRoot, ".cache", "pytest-temp");
mkdirSync(tempRoot, { recursive: true });
const runId = `${Date.now()}-${process.pid}`;

const runs = [
  { name: "infra", configPath: null, path: "tests/infra" },
  { name: "video-worker", configPath: "workers/video-worker/pytest.ini", path: "workers/video-worker" },
  { name: "ai-worker", configPath: "workers/ai-worker/pytest.ini", path: "workers/ai-worker" },
];

function pytestArgs(run) {
  const tempDir = join(tempRoot, `${run.name}-${runId}`);
  mkdirSync(tempDir, { recursive: true });
  return {
    args: [
      "-m", "pytest", "-p", "no:cacheprovider",
      "--basetemp", tempDir,
      ...(run.configPath ? ["-c", run.configPath] : []),
      run.path,
    ],
    tempDir,
  };
}

for (const run of runs) {
  const { args, tempDir } = pytestArgs(run);
  let result;
  if (useDocker) {
    const image = process.env.PY_TEST_IMAGE || "python:3.12-slim";
    const reqFile = `${run.path}/requirements.txt`;
    const containerArgs = args.map((a) =>
      a.startsWith(workspaceRoot) ? "/workspace" + a.slice(workspaceRoot.length).replace(/\\/g, "/") : a
    );
    const installAndRun = existsSync(join(workspaceRoot, reqFile))
      ? `pip install -q --root-user-action=ignore pytest -r ${reqFile} && python ${containerArgs.map((a) => `'${a}'`).join(" ")}`
      : `pip install -q --root-user-action=ignore pytest && python ${containerArgs.map((a) => `'${a}'`).join(" ")}`;
    const dockerArgs = [
      "run", "--rm",
      "-v", `${workspaceRoot}:/workspace`,
      "-w", "/workspace",
      "-e", "PYTHONDONTWRITEBYTECODE=1",
      image,
      "sh", "-c", installAndRun,
    ];
    console.log(`[test:workers] ${run.name} via docker (${image})`);
    result = spawnSync("docker", dockerArgs, { stdio: "inherit", shell: false });
  } else {
    console.log(`[test:workers] ${run.name} via ${localPython}`);
    result = spawnSync(localPython, args, {
      env: { ...process.env, TMP: tempDir, TEMP: tempDir, TMPDIR: tempDir },
      stdio: "inherit",
      shell: false,
    });
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
