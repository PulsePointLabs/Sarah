import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

function gitValue(command, fallback = "") {
  try {
    return execSync(command, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
}

const info = {
  appName: "Sarah",
  version: packageJson.version || "0.0.0",
  commit: gitValue("git rev-parse --short HEAD", "unknown"),
  commitMessage: gitValue("git log -1 --pretty=%s", "Unknown build"),
  builtAt: new Date().toISOString(),
};

const outputPath = resolve(repoRoot, "src/generated/buildInfo.js");
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `export const BUILD_INFO = ${JSON.stringify(info, null, 2)};\n`,
  "utf8",
);
