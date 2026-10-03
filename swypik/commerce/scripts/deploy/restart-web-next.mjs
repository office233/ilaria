import { execSync } from "node:child_process";

function run(cmd) {
    console.log(`\n> ${cmd}`);
    return execSync(cmd, { stdio: "inherit" });
}

try {
    const wslCommands = [
        "cd /opt/swypik/app",
        "docker rm -f swypik-prod-web-next-1 2>/dev/null || true",
        "docker compose -f infra/hetzner/docker-compose.prod.yml -f infra/hetzner/docker-compose.vps.yml -f infra/hetzner/docker-compose.minio.yml --env-file infra/hetzner/.env.production up -d --no-deps web-next",
        "docker ps --filter 'name=web-next'"
    ].join(" && ");

    run(`wsl -d swypik bash -c "${wslCommands}"`);
    console.log("\nContainer successfully restarted with newest build!");
} catch (err) {
    console.error("Restart failed:", err.message);
    process.exit(1);
}
