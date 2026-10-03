#!/usr/bin/env node
// Deploy the current `main` to the WSL distro (swypik) and rebuild web-next.
//
// SAFETY (2026-09-24 audit fix): the previous version ran `git add -A` +
// committed with a hardcoded message on every run — that created duplicate
// commits — and reset the server checkout with `git checkout -- .` +
// `git clean -fd`, which silently discards any local server-side changes.
// This version:
//   - never runs `git add`/`git commit` itself
//   - refuses to run if the local working tree is dirty
//   - only pushes to origin/main when invoked with --push
//   - pulls on the server with `git pull --ff-only` and ABORTS on failure
//     instead of blowing away the server checkout
import { execSync } from "node:child_process";

function run(cmd, opts = {}) {
    console.log(`\n> ${cmd}`);
    return execSync(cmd, { stdio: "inherit", ...opts });
}

function runCapture(cmd) {
    return execSync(cmd, { encoding: "utf8" });
}

const shouldPush = process.argv.includes("--push");

try {
    console.log("=== 1. Checking local working tree ===");
    const status = runCapture("git status --porcelain");
    if (status.trim().length > 0) {
        console.error(
            "Working tree is dirty. Commit or stash your changes before deploying:\n" + status
        );
        process.exit(1);
    }
    console.log("Working tree clean.");

    if (shouldPush) {
        console.log("\n=== 2. Push origin main (--push passed) ===");
        run("git push origin main");
    } else {
        console.log("\n=== 2. Skipping push (pass --push to push origin main first) ===");
    }

    console.log("\n=== 3. Pull & rebuild on WSL (distro swypik) ===");
    const wslCommands = [
        "cd /opt/swypik/app",
        // `git pull --ff-only` refuses (non-zero exit) instead of discarding
        // any local server-side state the way `checkout -- . && clean -fd` did.
        "git pull --ff-only origin main || { echo 'git pull --ff-only failed — resolve manually on the server, aborting'; exit 1; }",
        "docker compose -f infra/hetzner/docker-compose.prod.yml -f infra/hetzner/docker-compose.vps.yml -f infra/hetzner/docker-compose.minio.yml --env-file infra/hetzner/.env.production build web-next",
        "docker compose -f infra/hetzner/docker-compose.prod.yml -f infra/hetzner/docker-compose.vps.yml -f infra/hetzner/docker-compose.minio.yml --env-file infra/hetzner/.env.production up -d --no-deps --force-recreate web-next",
        "docker ps | grep web-next"
    ].join(" && ");

    run(`wsl -d swypik bash -c "${wslCommands}"`);

    console.log("\n=== 4. Deployment complete! ===");
} catch (err) {
    console.error("Deployment step failed:", err.message);
    process.exit(1);
}
