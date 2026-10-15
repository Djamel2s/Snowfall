import net from "node:net";

// Analyse antivirus des fichiers reçus par ClamAV (démon clamd, protocole
// INSTREAM sur TCP). Le fichier est transmis en mémoire, jamais écrit sur
// disque ; clamd tourne dans son propre conteneur, sans accès à l'API.

export type ScanResult = { clean: true } | { clean: false; signature: string };

export interface MalwareScanner {
  scan(bytes: Buffer): Promise<ScanResult>;
}

/** Analyse impossible (service injoignable, délai, limite) : le fichier est refusé. */
export class ScannerUnavailableError extends Error {
  constructor(reason: string) {
    super(`SCANNER_${reason}`);
  }
}

export type ClamdConfig = { host: string; port: number; timeoutMs: number };

const CHUNK = 64 * 1024;

export class ClamdScanner implements MalwareScanner {
  constructor(private readonly config: ClamdConfig) {}

  scan(bytes: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.config.host, port: this.config.port });
      let response = "";
      let settled = false;
      const finish = (error: Error | null, result?: ScanResult) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(result!);
      };

      socket.setTimeout(this.config.timeoutMs, () => finish(new ScannerUnavailableError("TIMEOUT")));
      socket.on("error", () => finish(new ScannerUnavailableError("UNREACHABLE")));
      socket.on("data", (data: Buffer) => {
        response += data.toString("utf8");
        if (response.includes("\0")) parse();
      });
      socket.on("end", parse);
      socket.on("close", parse);

      function parse() {
        if (settled) return;
        const line = response.replace(/\0/g, "").trim();
        if (!line) return finish(new ScannerUnavailableError("EMPTY_RESPONSE"));
        if (/^stream: OK$/.test(line)) return finish(null, { clean: true });
        const found = /^stream: (.{1,200}) FOUND$/.exec(line);
        if (found) return finish(null, { clean: false, signature: found[1]! });
        // « INSTREAM size limit exceeded », erreur interne… : jamais considéré sain.
        return finish(new ScannerUnavailableError("REFUSED"));
      }

      socket.on("connect", () => {
        // Commande préfixée « z » : terminée par un octet nul.
        socket.write("zINSTREAM\0");
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          const piece = bytes.subarray(offset, offset + CHUNK);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(piece.length);
          socket.write(size);
          socket.write(piece);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}
