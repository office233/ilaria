import fs from "node:fs";
import path from "node:path";

const nextDir = path.resolve(process.cwd(), ".next");
if (fs.existsSync(nextDir)) {
  fs.rmSync(nextDir, { recursive: true, force: true });
  console.log("Cleaned .next folder successfully.");
} else {
  console.log(".next does not exist.");
}
