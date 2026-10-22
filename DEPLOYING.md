# Deploying the demo

The demo has two parts that live in different places:

- **The demo server** ([`apps/demo-server`](./apps/demo-server/README.md)) is a long-running
  WebSocket process. It goes to [Fly.io](https://fly.io) as a container (`fly.toml`).
- **The web page** ([`apps/web`](./apps/web/README.md)) is a Next.js app. It goes to
  [Vercel](https://vercel.com) (`apps/web/vercel.json`).

Each needs the other's URL, so create the server first, then the page, then tell the server which
page may use it. Check both providers' current pricing and free allowances before you start.

## 1. The server on Fly.io

You need `flyctl` and an account (`fly auth login`). Run everything from the **repository root**:
the Docker build needs the whole pnpm workspace.

```bash
fly launch --no-deploy --copy-config   # keep the existing fly.toml; pick a name and the nearest region
fly deploy
fly scale count 1                      # the server keeps sessions in memory: exactly one machine
fly status                             # check: one machine, started, health check passing
curl https://<your-app>.fly.dev/state  # {"connections":0,"silent":false,…}
```

The server's state lives in one process, so two machines would break it: a token issued by one is
unknown to the other, and visitors would be thrown out with an auth failure. That is why
`fly scale count 1` matters.

## 2. The page on Vercel

1. Import the repository as a new project. Set **Root Directory** to `apps/web` and leave
   "Include source files outside of the Root Directory" on (the build needs the workspace).
   The install and build commands come from `apps/web/vercel.json`.
2. Add these environment variables:
   - `NEXT_PUBLIC_DEMO_SERVER` = `https://<your-app>.fly.dev`. It is read when the app is built, so
     changing it means redeploying.
   - `ENABLE_EXPERIMENTAL_COREPACK` = `1`, so Vercel uses the pnpm version the repository pins.
3. Deploy. You get `https://<project>.vercel.app`.

## 3. Let the page use the server

```bash
fly secrets set ALLOWED_ORIGINS=https://<project>.vercel.app
```

This turns on [public mode](./apps/demo-server/README.md#running-it-for-other-people-public-mode)
and restarts the server. List several origins with commas (a custom domain, for example). The
value is not secret, `fly secrets` is just the simplest place to set it. Vercel preview
deployments have their own URLs and are **not** allowed unless you add them.

## 4. Check it

- Open the page: the state should reach `open` and the position should count up.
- Press the buttons in "Break it". Open the page in a second tab: its connection should not be
  affected by the first one's buttons.
- A page from anywhere else must be refused:

  ```bash
  curl -i -X POST -H "Origin: https://evil.example" \
    "https://<your-app>.fly.dev/control/silent?session=abcdefgh1234"   # 403
  ```

## If it gets abused

Public mode limits what one visitor can do, but it does not stop a determined attacker (see the
server README). To stop it, `fly scale count 0`, or `fly apps destroy <your-app>` to remove it.
