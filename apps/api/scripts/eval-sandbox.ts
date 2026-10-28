// Bac à sable RÉEL pour le banc d'évaluation : l'image de production, lancée
// durcie comme dans scripts/sandbox-attack.sh (sans réseau, lecture seule,
// capacités minimales), dans des conteneurs JETABLES supprimés à la fin.
// Le banc lui parle par son socket Unix, depuis un conteneur client qui n'a
// accès qu'au socket (comme l'API) : `docker exec` relaie chaque requête.
import { execFile, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { CodeSandbox, SandboxResult } from "../src/agent/code-tool.js";

const run = promisify(execFile);
const IMAGE = "snowfall-sandbox:eval";

// Client minimal : la requête arrive sur stdin, la réponse repart sur stdout.
const CLIENT = `
import http.client, socket, sys
class C(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(120)
        self.sock.connect("/run/sandbox/sandbox.sock")
body = sys.stdin.buffer.read()
c = C("sandbox", timeout=120)
c.request("POST", "/run", body=body, headers={"Content-Type": "application/json"})
r = c.getresponse()
sys.stdout.write(str(r.status) + "\\n")
sys.stdout.flush()
sys.stdout.buffer.write(r.read())
`;

export async function startEvalSandbox(): Promise<CodeSandbox & { stop: () => Promise<void> }> {
  const id = `snowfall-eval-sandbox-${process.pid}`;
  const [server, client, volume] = [`${id}-server`, `${id}-client`, `${id}-run`];
  const stop = async () => {
    await run("docker", ["rm", "-f", server, client]).catch(() => undefined);
    await run("docker", ["volume", "rm", volume]).catch(() => undefined);
  };
  // Sortie imprévue (erreur, Ctrl+C) : nettoyage SYNCHRONE, le seul qui s'exécute à la sortie.
  const cleanup = () => {
    spawnSync("docker", ["rm", "-f", server, client], { stdio: "ignore" });
    spawnSync("docker", ["volume", "rm", volume], { stdio: "ignore" });
  };
  process.once("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => process.exit(130));

  await run("docker", ["build", "-q", "-t", IMAGE, fileURLToPath(new URL("../../sandbox", import.meta.url))], { maxBuffer: 8 * 1024 * 1024 });
  await run("docker", ["volume", "create", volume]);
  // prettier-ignore
  await run("docker", ["run", "-d", "--name", server, "--init", "--network", "none", "--read-only",
    "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "KILL", "--cap-add", "CHOWN",
    "--security-opt", "no-new-privileges:true", "--pids-limit", "128", "--memory", "2g", "--cpus", "2",
    "--tmpfs", "/work:size=256m,mode=0711", "--tmpfs", "/tmp:size=16m,mode=0700", "--tmpfs", "/dev/shm:size=16m,mode=0700",
    "-v", `${volume}:/run/sandbox`, IMAGE]);
  // prettier-ignore
  await run("docker", ["run", "-d", "--name", client, "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--user", "20000:20000", "--group-add", "10010", "-v", `${volume}:/run/sandbox`, "--entrypoint", "sleep", IMAGE, "infinity"]);
  for (let attempt = 0; attempt < 30; attempt++) {
    const { stdout, stderr } = await run("docker", ["logs", server]).catch(() => ({ stdout: "", stderr: "" }));
    if (`${stdout}${stderr}`.includes("prêt")) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  return {
    stop,
    run: (code, options) =>
      new Promise<SandboxResult>((resolve, reject) => {
        const body = JSON.stringify(options.skill ? { ...options.skill, timeoutSeconds: options.timeoutSeconds } : { code, timeoutSeconds: options.timeoutSeconds });
        const child = spawn("docker", ["exec", "-i", client, "python3", "-I", "-c", CLIENT], { signal: options.signal });
        const chunks: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.on("error", reject);
        child.on("close", () => {
          const output = Buffer.concat(chunks).toString("utf8");
          const newline = output.indexOf("\n");
          const status = output.slice(0, newline);
          if (status !== "200") return reject(new Error(`SANDBOX_${status || "UNREACHABLE"}`));
          try {
            resolve(JSON.parse(output.slice(newline + 1)) as SandboxResult);
          } catch {
            reject(new Error("SANDBOX_INVALID_RESPONSE"));
          }
        });
        child.stdin.end(body);
      }),
  };
}
