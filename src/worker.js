// BeatJev Worker. Static files in public/ are served by the assets binding;
// this handles POST /api/classify, which asks Jev whether a message is spam.
// Without the TYPESAFE_API_KEY secret it answers from a labelled MOCK so the game
// is playable locally. The mock is not Jev.

import { TypeSafeClient, noul } from "@typesafe-ai/sdk";
import { MESSAGES } from "../public/messages.js";

const JEV_TIMEOUT_MS = 3000;
const KNOWN_TEXTS = new Set(MESSAGES.map(m => m.text));

const json = (status, payload) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/classify") return classify(request, env);
    if (url.pathname.startsWith("/api/")) return json(404, { error: "not found" });
    return env.ASSETS.fetch(request);
  },
};

async function classify(request, env) {
  if (request.method !== "POST") return json(405, { error: "POST only" });
  let text;
  try { ({ text } = await request.json()); } catch { return json(400, { error: "invalid JSON" }); }
  if (!KNOWN_TEXTS.has(text)) return json(400, { error: "unknown message" });

  if (!env.TYPESAFE_API_KEY) return json(200, await mock(text));

  // One attempt only: a retry would silently add seconds to "Jev's time".
  const client = new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY, retry: { maxRetries: 0 } });
  const t0 = performance.now();
  try {
    const response = await client.systemOne(
      {
        state: { message: text },
        questions: {
          is_spam: noul(
            "This message is spam, a scam, or unsolicited/deceptive marketing",
            { true: "Clearly spam, phishing, or a scam", false: "A normal, legitimate message" },
          ),
        },
      },
      { timeout: JEV_TIMEOUT_MS, signal: AbortSignal.timeout(JEV_TIMEOUT_MS) },
    );
    // Workers freeze the clock during CPU work but advance it across network I/O,
    // so this span is the edge-to-TypeSafe round trip.
    const latencyMs = performance.now() - t0;
    const probability = response.answers.is_spam.noul;
    return json(200, {
      isSpam: probability >= 0.5,
      probability,
      // A Noul answer carries only the probability; confidence is its distance from a coin flip.
      confidence: Math.abs(probability - 0.5) * 2,
      latencyMs: Math.round(latencyMs),
      mock: false,
    });
  } catch (e) {
    const elapsed = Math.round(performance.now() - t0);
    const timedOut = e?.name === "APITimeoutError" || e?.name === "TimeoutError" || e?.name === "APIUserAbortError" || elapsed >= JEV_TIMEOUT_MS;
    console.error("jev call failed", e?.name, e?.message);
    return json(timedOut ? 504 : 502, { error: timedOut ? "timeout" : "upstream", latencyMs: elapsed });
  }
}

// Keyword heuristic with a fake delay. Shape-compatible, intelligence-free.
async function mock(text) {
  const hits = (text.match(/\b(won|winner|free|urgent|click|claim|verify|guaranteed|suspend\w*|locked|password|singles|warranty|meds|crypto|\$\d[\d,]*\/week|fee|call us|agency)\b/gi) ?? []).length;
  const probability = Math.round(1000 / (1 + Math.exp(-(hits * 1.6 - 1.4)))) / 1000;
  const latencyMs = 90 + Math.round(Math.random() * 120);
  await new Promise(r => setTimeout(r, latencyMs));
  return { isSpam: probability >= 0.5, probability, confidence: Math.abs(probability - 0.5) * 2, latencyMs, mock: true };
}
