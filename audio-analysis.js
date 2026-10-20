import { Worker } from "node:worker_threads";

export function createAudioAnalyser() {
  let active = null;
  const analyse = (input, generation) => new Promise((resolve, reject) => {
    active?.terminate();
    const worker = new Worker(new URL("./audio-analysis-worker.js", import.meta.url), { workerData: { input } });
    active = worker;
    worker.once("message", message => {
      if (active === worker) active = null;
      if (message.ok) resolve(message.profile); else reject(new Error(message.error));
    });
    worker.once("error", reject);
    worker.once("exit", code => { if (code && active === worker) reject(new Error(`Audio analysis worker exited with code ${code}`)); });
  });
  analyse.close = async () => { const worker = active; active = null; await worker?.terminate(); };
  return analyse;
}
