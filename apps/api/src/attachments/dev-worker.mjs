// Développement uniquement (API lancée par tsx) : enregistre le chargeur
// TypeScript dans le worker, puis exécute le vrai script. En production, le
// worker compilé (extract-worker.js) est lancé directement.
import { workerData } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
await import(workerData.entry);
