# CowAgent Desktop

Cross-platform desktop client for CowAgent, built with Electron + React + TypeScript.

## Development

### Prerequisites

- Node.js 18+
- npm or yarn
- Python 3.7+ (for the backend)

### Setup

```bash
cd desktop
npm install
```

### Run in Development

Start the renderer dev server and Electron together:

```bash
npm run dev
```

Or run them separately:

```bash
# Terminal 1: Start Vite dev server
npm run dev:renderer

# Terminal 2: Start Electron (after renderer is ready)
npm run dev:main
```

The app will automatically start the Python backend from the parent directory.

### Build

```bash
# Build for current platform
npm run dist

# Build for macOS only
npm run dist:mac

# Build for Windows only
npm run dist:win
```

Build outputs are placed in the `release/` directory.

## Architecture

```
desktop/
├── src/
│   ├── main/              # Electron main process
│   │   ├── index.ts       # Window management, IPC
│   │   ├── python-manager.ts  # Python backend lifecycle
│   │   └── preload.ts     # Context bridge for renderer
│   └── renderer/          # React UI (Vite)
│       └── src/
│           ├── api/       # HTTP client for backend APIs
│           ├── components/ # Reusable UI components
│           ├── hooks/     # React hooks
│           ├── pages/     # Page components
│           └── types.ts   # TypeScript types
├── resources/             # App icons
├── package.json           # Dependencies and build config
└── vite.config.ts         # Vite config
```

### How it Works

1. Electron main process starts and creates the app window
2. It spawns the Python backend (`app.py`) as a child process
3. The React UI communicates with the Python backend via HTTP APIs
4. SSE (Server-Sent Events) is used for streaming chat responses and live logs

## Fork notes: this build is 教师工作台, not CowAgent

This repo is a fork of CowAgent re-targeted as a teacher workbench. That changes
what the auto-updater must do, because the default feed
(`https://cowagent.ai/update/`) serves the **upstream** product: installing an
"update" from it would replace this build's frontend and bundled
skills/plugins with upstream's.

The updater is therefore driven by `resources/app-config.json`, staged from
`flavors/<name>/` by `scripts/apply-flavor.mjs` (the release workflow stages
`teacher-workbench`):

| `updateFeedUrl` | Behaviour |
| --- | --- |
| `"off"` (or `none`/`disabled`/`false`) | updater is not wired at all; "check for update" replies "up to date" |
| `"https://host/update/"` | generic feed; the client reads `latest.yml` (win) / `latest-mac.yml` (mac) there |
| **an array of URLs** | failover list, tried in order (mirror first, direct origin last) |
| absent | falls back to the upstream CowAgent feed — **never ship this** |

### Feed for users in mainland China

`desktop/flavors/teacher-workbench/app-config.json` ships the failover list:

```
https://ghfast.top/https://github.com/sgj666/MyPersonalAgent/releases/latest/download/
https://gh-proxy.com/https://github.com/sgj666/MyPersonalAgent/releases/latest/download/
https://github.com/sgj666/MyPersonalAgent/releases/latest/download/      <- always works, never delete
```

`updater.ts` walks the list on any check/download failure, and remembers the
entry that answered (`userData/update-feed.json`), so the next launch starts on a
healthy mirror. Measured from a mainland connection: direct GitHub ~2.4 MB/s (the
feed 302s to GitHub's CDN), `ghfast.top` ~2.3 MB/s, `gh-proxy.com` ~65 KB/s —
hence the order above and the direct URL as the final safety net.

The list is baked into the build, so **changing mirrors requires a new release**.
That is safe as long as one entry still works (normally the direct GitHub one);
if every entry dies, installed clients must reinstall manually.

### Publishing a release (this fork's own feed)

```bash
gh workflow run release.yml -f version=2.3.0 -f publish_github=true
```

`publish-github` then creates a **normal** (not prerelease, not draft) GitHub
Release `v2.3.0` holding the installers, `latest.yml` / `latest-mac.yml` and the
blockmaps — i.e. exactly what `releases/latest/download/` serves.

Rules:

- Version must be plain semver (`2.3.0`). A pre-release version such as
  `2.2.2-win-test` makes electron-builder emit `win-test.yml` instead of
  `latest.yml`, and `releases/latest` skips prereleases entirely.
- The version must be **greater** than what clients run, or nothing is offered.
- `release.yml`'s `publish_r2` job belongs to the upstream product (its R2 bucket
  and D1 registry); this fork refuses to run it unless the repo variable
  `ALLOW_UPSTREAM_PUBLISH=true` is set.

Known limits for a self-hosted feed:

- **macOS** auto-update needs a Developer ID signature on both the running app
  and the update; an unsigned mac build cannot install its own updates
  (Squirrel.Mac refuses it). Windows does not have this requirement.
- `appId` / `productName` are still `com.cowagent.desktop` / `CowAgent`, so this
  build shares an install directory and uninstall entry with upstream CowAgent.
  Change both (plus `app-config.json`'s `appUserModelId`) before shipping both
  products to the same users.
