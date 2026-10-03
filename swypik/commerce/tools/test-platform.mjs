import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const workspaceRoot = process.cwd();
const platformApiDir = join(workspaceRoot, "services", "platform-api");
const goCacheDir = join(workspaceRoot, ".cache", "go-build");
mkdirSync(goCacheDir, { recursive: true });

function hasCmd(cmd) {
  const probe = process.platform === "win32"
    ? spawnSync("where", [cmd], { stdio: "ignore", shell: false })
    : spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
  return probe.status === 0;
}

const goCmd = process.platform === "win32" ? "go.exe" : "go";
const useDocker = !hasCmd(goCmd) && hasCmd("docker");

let result;
if (useDocker) {
  const image = process.env.GO_TEST_IMAGE || "golang:1.26.2";
  const args = [
    "run", "--rm",
    "-v", `${workspaceRoot}:/workspace`,
    "-w", "/workspace/services/platform-api",
    "-e", "GOCACHE=/workspace/.cache/go-build",
    "-e", "GOMODCACHE=/workspace/.cache/go-mod",
    image,
    "go", "test", "./...",
  ];
  console.log(`[test:platform] running via docker (${image})`);
  result = spawnSync("docker", args, { stdio: "inherit", shell: false });
} else {
  console.log(`[test:platform] running via local ${goCmd}`);
  result = spawnSync(goCmd, ["test", "./..."], {
    cwd: platformApiDir,
    env: { ...process.env, GOCACHE: goCacheDir },
    stdio: "inherit",
    shell: false,
  });
}

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
