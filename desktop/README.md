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
| `"https://your.host/update/"` | generic feed; the client fetches `latest.yml` (win) / `latest-mac.yml` (mac) from there |
| absent | falls back to the upstream CowAgent feed — **never ship this** |

To self-host auto-update, publish, for each release:

1. the installer(s) — `CowAgent-Setup-<ver>-x64.exe`, `CowAgent-<ver>-<arch>.zip` (mac);
2. `latest.yml` / `latest-mac.yml` (electron-builder writes these next to the
   installers, even with `--publish never`), unchanged, in the same directory.

Use plain semver versions (`2.3.0`). A pre-release version like `2.2.2-win-test`
makes electron-builder name the metadata `win-test.yml` instead of `latest.yml`.

Known limits for a self-hosted feed:

- **macOS** auto-update needs a Developer ID signature on both the running app
  and the update; an unsigned mac build cannot install its own updates
  (Squirrel.Mac refuses it). Windows does not have this requirement.
- `appId` / `productName` are still `com.cowagent.desktop` / `CowAgent`, so this
  build shares an install directory and uninstall entry with upstream CowAgent.
  Change both (plus `app-config.json`'s `appUserModelId`) before shipping both
  products to the same users.
