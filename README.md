# xenocept-plugin-aeor-codex

Xenocept plugin for Codex. It has two independent roles:

- Destination: render the canonical session template and send it to a
  running Codex app-server thread through the plugin's Lua bridge.
- OCR: use the OpenAI Responses API to enrich submitted screenshots with
  `ocr_text` and `alternative_description` for Xenocept search.

## Requirements

- Xenocept running locally.
- For destination delivery: Codex app-server listening on a WebSocket URL
  reachable from the Xenocept host process.
- For OCR: an OpenAI API key.

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

OCR does not require Codex CLI or app-server. Configure it from the
Codex plugin page in Xenocept's Plugins settings:

- Enable Codex OCR.
- Add an OpenAI API key.
- Choose a vision model. `gpt-5.4-mini` is the default for lower-cost,
  lower-latency per-screenshot OCR.
- Hold the "make OCR master" button if Codex should run before the other
  OCR plugins.

OCR requests are sent to `https://api.openai.com/v1/responses` with
`store: false`.

## Delivery Modes

### Send

Default. Sends the Xenocept session as a new user turn with
`turn/start`, so Codex reacts immediately in the selected thread.

### Queue

Advanced. Appends a raw user message to model-visible thread history
with `thread/inject_items`. Codex will see it on a later turn, but it
does not start work by itself.

## Thread Selection

The config dialog starts the plugin bridge if needed, then asks that Lua
bridge to load recent Codex threads from the running app-server with
`thread/list`. When a Xenocept session is sent, the Lua bridge resumes
the selected thread with `thread/resume` before sending or queueing.

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

That side-loads `index.mjs`, `main.lua`, and `package.json` into
Xenocept's plugin store. Reload Xenocept, then add a destination under
Settings -> Destinations.

## License

MIT
