/**
 * Cloudflare front door. A Worker that forwards every request (the HubSpot
 * webhook, /healthz) to ONE long-lived container running worker.js from the
 * Dockerfile at the repo root. Everything that matters happens in there.
 *
 * The cron in wrangler.jsonc pings the container every 5 minutes, which keeps
 * it awake: webhooks never wait on a cold Chromium start (HubSpot gives up
 * after 5 s), and worker.js's reconcile loop keeps running.
 */
import { Container, getContainer } from "@cloudflare/containers";
import { env } from "cloudflare:workers";

// Secrets (wrangler secret put) and vars (wrangler.jsonc) the container needs.
const PASS_THROUGH = [
  "HS_TOKEN",
  "HS_CLIENT_SECRET",
  "WEBHOOK_URL",
  "AUTO_ON_FINALISE",
  "AUTO_SINCE",
  "RECONCILE_MS",
];

export class InvoiceWorker extends Container {
  defaultPort = 8080;
  pingEndpoint = "healthz";
  sleepAfter = "15m"; // never reached while the cron runs
  envVars = Object.fromEntries(
    PASS_THROUGH.filter((k) => env[k] !== undefined && env[k] !== "").map((k) => [k, String(env[k])]),
  );
}

// One instance, always the same one: the render queue lives in its memory.
const single = (env) => getContainer(env.INVOICE_WORKER, "singleton");

export default {
  fetch(request, env) {
    return single(env).fetch(request);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(single(env).fetch(new Request("https://container/healthz")));
  },
};
