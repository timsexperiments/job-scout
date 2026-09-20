import { homedir } from "node:os";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { log, root } from "../src/io.ts";

if (process.platform !== "darwin" || !process.getuid) throw new Error("This service installer supports macOS. Other systems can run bun run start under their service manager.");
const label = process.env.JOB_SCOUT_SERVICE_LABEL ?? "local.job-scout";
const file = resolve(homedir(), "Library/LaunchAgents", `${label}.plist`);
const domain = `gui/${process.getuid()}`;
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
async function launchctl(args: string[], tolerateFailure = false) {
  const child = Bun.spawn(["/bin/launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code && !tolerateFailure) throw new Error(error.trim() || `launchctl exited ${code}`);
}
const command = process.argv[2];
if (command === "install") {
  await mkdir(resolve(homedir(), "Library/LaunchAgents"), { recursive: true });
  await mkdir(resolve(root, "data"), { recursive: true, mode: 0o700 });
  const logPath = resolve(root, "data/server.log");
  await writeFile(logPath, "", { flag: "a", mode: 0o600 });
  if (await Bun.file(file).exists()) await launchctl(["bootout", `${domain}/${label}`], true);
  await writeFile(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(resolve(root, "src/server.ts"))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(logPath)}</string><key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict></plist>\n`, { mode: 0o600 });
  await launchctl(["bootstrap", domain, file]);
  log("service_installed", { url: "http://127.0.0.1:4317", launchAgent: file });
} else if (command === "stop") {
  await launchctl(["bootout", `${domain}/${label}`], true); log("service_stopped");
} else if (command === "uninstall") {
  await launchctl(["bootout", `${domain}/${label}`], true);
  if (await Bun.file(file).exists()) await unlink(file);
  log("service_uninstalled", { dataPreserved: true });
} else throw new Error("Usage: bun run service install|stop|uninstall");
