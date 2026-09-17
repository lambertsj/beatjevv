# BeatJev

A human vs. TypeSafe's Jev in a 25-round spam-or-not reaction race. Each round has a 3-2-1 countdown. When it hits zero, the message appears, your timer starts, and the page asks Jev the same question, all on the same tick. After 25 rounds, a results screen compares speed and accuracy and gives you a share link for X and a result image.

It's a Cloudflare Worker. `public/` is served as static assets (plain HTML/CSS/JS, no build step). `src/worker.js` handles `POST /api/classify` and calls Jev through `@typesafe-ai/sdk`, so the API key stays server-side.

## Deploy

```bash
npm install
npx wrangler login
npx wrangler secret put TYPESAFE_API_KEY   # required before the first deploy
npx wrangler deploy                        # → https://beatjev.<you>.workers.dev
```

## Local

```bash
echo 'TYPESAFE_API_KEY=...' > .dev.vars    # optional, gitignored
npx wrangler dev                           # http://localhost:8787
```

Without a key, the Worker answers from a keyword **MOCK** with a fake delay, and the page shows a MOCK badge. The mock is not Jev.

## API

`POST /api/classify` with `{ "text": "..." }` returns `{ isSpam, probability, confidence, latencyMs }`.

- The call is a Noul question, "is this spam, a scam, or deceptive marketing". `isSpam` is `probability >= 0.5`.
- A Noul answer only carries the probability, so `confidence` is derived as `|probability − 0.5| × 2`.
- `latencyMs` is measured in the Worker around `client.systemOne()` only. It's Jev's decision time plus the edge-to-TypeSafe hop, and doesn't include the player's own trip to the Worker.
- The Jev call has a 3s timeout and no retries, since a retry would quietly add to Jev's time. On timeout the route returns 504 `{ error: "timeout" }`, the round shows "Jev didn't respond in time", and it counts as wrong for Jev and is left out of Jev's average.
- `text` must be one of the 25 messages in `public/messages.js`. The endpoint is public and spends your key, so it won't classify arbitrary input.

## Fairness notes

- The message order is shuffled every game.
- Your tap is timed on `pointerdown`, not `click`, so the finger lift doesn't count.
- If Jev answers before you, the card shows only its time. The verdict stays hidden until you pick, so you can't copy it.
