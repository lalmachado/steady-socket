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

1. In the Render dashboard choose **New → Blueprint** and connect this repository. Give the
   Blueprint a name (any unique one) and keep the branch on `main`: Render reads `render.yaml` from
   the root of that branch, and "`render.yaml` not found" means the file is not on it. Render then
   proposes one free web service (a Docker build from `apps/demo-server/Dockerfile`, health check
   on `/state`).
2. Render asks for `ALLOWED_ORIGINS`, which you do not know yet. Enter `https://placeholder.invalid`.
   The container refuses to start with an empty value, so a mistake cannot leave it open to
   everyone.
3. Apply. The first build takes a few minutes. When it is live, open
   `https://<service>.onrender.com/state`: you should see `{"connections":0,…}`. The root URL
   answers `{"error":"session is required"}`, which is correct: public mode wants a session on
   every call except `/state`.

## 2. The page on Vercel

1. Import the repository as a new project. Set **Root Directory** to `apps/web` and leave
   "Include source files outside of the Root Directory" on (the build needs the workspace).
   The install and build commands come from `apps/web/vercel.json`.
2. Add these environment variables:
   - `NEXT_PUBLIC_DEMO_SERVER` = `https://<service>.onrender.com`. It is read when the app is
     built, so changing it means redeploying. Its type must be **Config**, not Secret or
     Sensitive: a `NEXT_PUBLIC_` value ends up in the page's JavaScript, so Vercel warns about it
     and, once a variable is saved as a secret, cannot change it to Config. Delete it and add it
     again instead.
   - `ENABLE_EXPERIMENTAL_COREPACK` = `1`, so Vercel uses the pnpm version the repository pins.
3. Deploy. You get `https://<project>.vercel.app`.

## 3. Let the page use the server

In Render, open the service's **Environment** tab and set `ALLOWED_ORIGINS` to
`https://<project>.vercel.app` (an origin: no path, no trailing slash). List several with commas,
for a custom domain for example. Saving redeploys the server. The value is not secret.

Vercel preview deployments have their own URLs and are **not** allowed unless you add them.

## 4. Check it

- Open the page. If the server was asleep, the state shows `connecting` or `reconnecting` and then
  the waiting hint; give it a minute. Then it should reach `open` and the clock should tick.
- Press the buttons in "Break it". Open the page in a second tab: its connection should not be
  affected by the first one's buttons.
- A page from anywhere else must be refused:

  ```bash
  curl -i -X POST -H "Origin: https://evil.example" \
    "https://<service>.onrender.com/control/silent?session=abcdefgh1234"   # 403
  ```

## Before a big post (for example Show HN)

A front-page post sends a crowd at once. Checks worth doing the day before:

- **Keep the server awake.** A free Render service sleeps after 15 minutes without traffic and the
  first visitor waits for it to wake (the server itself starts in about 2.5 s on a small CPU; most
  of the wait is Render's). Ping `https://<service>.onrender.com/state` every 10 minutes, with an
  uptime monitor or a scheduled job, from the day before until the post has settled. One free
  service has enough free hours to stay on all month, but check Render's current terms.
- **Know the room.** The server holds 500 visitors at once on the free plan (see
  [how many visitors it holds](./apps/demo-server/README.md#how-many-visitors-it-holds)). Past that,
  new visitors see "The demo is busy" and keep retrying, and get in when someone leaves; a visitor's
  connection is ended after 30 minutes, which frees the room of forgotten tabs. On a paid plan,
  raise `MAX_CONNECTIONS` and `MAX_SESSIONS`.
- **Try it from a phone on mobile data**, not only from your own computer.
- **Watch the Render dashboard's logs and CPU** during the first hour.

## If it gets abused

Public mode limits what one visitor can do, but it does not stop a determined attacker (see the
server README). To stop it, suspend the service in the Render dashboard, or delete it.
