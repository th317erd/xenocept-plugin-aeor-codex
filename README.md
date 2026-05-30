# xenocept-plugin-aeor-codex

Xenocept destination plugin for Codex. When you submit a Xenocept
session, this plugin renders the canonical session template and sends it
to a running Codex app-server thread.

## Requirements

- Xenocept running locally.
- Codex app-server listening on a WebSocket URL reachable from the
  Xenocept webview.

For local testing:

```sh
codex app-server --listen ws://127.0.0.1:14521
```

Use `ws://127.0.0.1:14521` in the destination config.

`codex remote-control start --json` is the nicer managed-daemon path
when Codex was installed through the standalone installer. This machine's
current Codex install does not provide that standalone daemon path, so
the direct `codex app-server --listen ...` command is the practical dev
route.

## Delivery Modes

### Start turn

Default. Sends the Xenocept session as a new user turn with
`turn/start`, so Codex reacts immediately in the selected thread.

### Inject context

Advanced. Appends a raw user message to model-visible thread history
with `thread/inject_items`. Codex will see it on a later turn, but it
does not start work by itself.

## Thread Selection

The config dialog loads recent Codex threads from the running app-server
with `thread/list`. When a Xenocept session is sent, the plugin resumes
the selected thread with `thread/resume` before starting the turn.

If no thread is selected, the plugin asks Codex for available threads:

- exactly one thread: use it
- zero threads: fail with a setup error
- more than one thread: fail and ask for an explicit thread ID

This avoids the comedic version of "helpful" where a screenshot meant
for one repo lands in another.

## Installation

### Local development

```sh
./dev-install.sh
```

That `PUT`s `index.mjs` and `package.json` into Xenocept's plugin store.
Reload Xenocept, then add a destination under Settings -> Destinations.

## License

MIT
