# Deploying the demo

The demo has two parts that live in different places, both on free plans:

- **The demo server** ([`apps/demo-server`](./apps/demo-server/README.md)) is a long-running
  WebSocket process. It goes to [Render](https://render.com) as a container (`render.yaml`).
- **The web page** ([`apps/web`](./apps/web/README.md)) is a Next.js app. It goes to
  [Vercel](https://vercel.com) (`apps/web/vercel.json`).

Each needs the other's URL, so the order is: server, page, then tell the server which page may
use it. Check both providers' current terms before you start; free plans change.

**What "free" means here.** Render's free web service goes to sleep after 15 minutes without
traffic and takes up to a minute to wake up. The web page notices and says so after three seconds
of waiting, and `steady-socket` keeps retrying until the server answers. Sessions live in memory,
so they are forgotten when the server sleeps. That is fine for a demo.

## 1. The server on Render

1. In the Render dashboard choose **New → Blueprint** and connect this repository. Render reads
   `render.yaml` at the root and proposes one free web service (a Docker build from
   `apps/demo-server/Dockerfile`, health check on `/state`).
2. Render asks for `ALLOWED_ORIGINS`, which you do not know yet. Enter `https://placeholder.invalid`.
   The container refuses to start with an empty value, so a mistake cannot leave it open to
   everyone.
3. Apply. The first build takes a few minutes. When it is live, open
   `https://<service>.onrender.com/state`: you should see `{"connections":0,…}`.

## 2. The page on Vercel

1. Import the repository as a new project. Set **Root Directory** to `apps/web` and leave
   "Include source files outside of the Root Directory" on (the build needs the workspace).
   The install and build commands come from `apps/web/vercel.json`.
2. Add these environment variables:
   - `NEXT_PUBLIC_DEMO_SERVER` = `https://<service>.onrender.com`. It is read when the app is
     built, so changing it means redeploying.
   - `ENABLE_EXPERIMENTAL_COREPACK` = `1`, so Vercel uses the pnpm version the repository pins.
3. Deploy. You get `https://<project>.vercel.app`.

## 3. Let the page use the server

In Render, open the service's **Environment** tab and set `ALLOWED_ORIGINS` to
`https://<project>.vercel.app` (an origin: no path, no trailing slash). List several with commas,
for a custom domain for example. Saving redeploys the server. The value is not secret.

Vercel preview deployments have their own URLs and are **not** allowed unless you add them.

## 4. Check it

- Open the page. If the server was asleep, the state shows `connecting` or `reconnecting` and then
  the waiting hint; give it a minute. Then it should reach `open` and the score should count up.
- Press the buttons in "Break it". Open the page in a second tab: its connection should not be
  affected by the first one's buttons.
- A page from anywhere else must be refused:

  ```bash
  curl -i -X POST -H "Origin: https://evil.example" \
    "https://<service>.onrender.com/control/silent?session=abcdefgh1234"   # 403
  ```

## If it gets abused

Public mode limits what one visitor can do, but it does not stop a determined attacker (see the
server README). To stop it, suspend the service in the Render dashboard, or delete it.
