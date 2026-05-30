# xenocept-plugin-aeor-codex

Xenocept destination plugin for Codex. When you submit a Xenocept
session, this plugin renders the canonical session template and sends it
to a running Codex app-server thread.

## Requirements

- Xenocept running locally.
- Codex app-server remote control enabled and listening on a WebSocket
  URL reachable from the Xenocept webview.

Start Codex remote control:

```sh
codex remote-control start --json
```

Use the returned WebSocket URL in the destination config. If your Codex
build requires a bearer/capability token, paste that token in the
optional auth token field.

## Delivery Modes

### Start turn

Default. Sends the Xenocept session as a new user turn with
`turn/start`, so Codex reacts immediately in the selected thread.

### Inject context

Advanced. Appends a raw user message to model-visible thread history
with `thread/inject_items`. Codex will see it on a later turn, but it
does not start work by itself.

## Thread Selection

If `Thread ID` is blank, the plugin asks Codex for loaded threads:

- exactly one loaded thread: use it
- zero loaded threads: fail with a setup error
- more than one loaded thread: fail and ask for an explicit thread ID

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
