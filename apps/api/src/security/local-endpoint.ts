// Adresse d'un service local isolé (bac à sable, OCR, décision) : un socket
// Unix (production : aucun port réseau ouvert) ou, en développement seulement,
// tcp://127.0.0.1:<port> vers un pont local (Docker Desktop sous Windows ou
// macOS ne partage pas les sockets Unix avec l'hôte). Jamais une autre machine.

export type LocalEndpoint = { socketPath: string } | { host: string; port: number };

const TCP = /^tcp:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/;

export function localEndpoint(value: string): LocalEndpoint {
  if (!value.startsWith("tcp:")) return { socketPath: value };
  const match = TCP.exec(value);
  const port = match ? Number(match[2]) : 0;
  if (!match || port < 1 || port > 65_535) throw new Error(`Adresse locale invalide : ${value} (socket Unix, ou tcp://127.0.0.1:<port> en développement).`);
  return { host: match[1] === "[::1]" ? "::1" : "127.0.0.1", port };
}

/** En production : socket Unix exigé (un port, même local, est joignable par tout processus de l'hôte). */
export function assertSocketInProduction(name: string, value: string | undefined, production: boolean) {
  if (production && value?.startsWith("tcp:")) throw new Error(`${name} : socket Unix exigé en production (tcp:// réservé au développement).`);
  if (value) localEndpoint(value);
}
