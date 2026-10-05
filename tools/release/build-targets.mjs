import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Optional argv[2]: output root (default dist). Release checks pass a scratch root so they never overwrite dist/.
const outRoot = path.resolve(root, process.argv[2] ?? "dist");
const targets = ["owner-review", "standalone", "poki", "crazygames-basic", "crazygames-full", "selfhost"];
for (const target of targets) {
  const result = spawnSync("npx", ["vite", "build", "--mode", target, "--emptyOutDir"], { cwd: root, stdio: "inherit", env: { ...process.env, LATERAL_OUT_ROOT: outRoot }, shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const result = spawnSync(process.execPath, [path.join(root, "tools/release/check-targets.mjs"), outRoot], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
