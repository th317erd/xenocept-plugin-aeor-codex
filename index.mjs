'use strict';

const PLUGIN_ID = 'org.aeor.xenocept.codex';
const DEFAULT_WS_URL = 'ws://127.0.0.1:14521';
const CONTROL_CHANNEL = 'xenocept-codex-control';
const BRIDGE_MODE = 'xenocept-codex-bridge';
const DEFAULT_TEMPLATE = `A Xenocept screen-annotation session was submitted for Codex.

Please acknowledge that you received it, inspect the session details below, and help with whatever the comments or screen context call out.

Session ID: {{ sessionID }}
Captured: {{ timestamp }}
Comments: {{ commentCount }}

What's on screen (AI-generated description):
{{ alternativeDescription }}

On-screen text (OCR):
{{ ocrText }}

User comments:
{{ comments >> EACH("- {{ text }}\\n  Image: {{ imageURL }}") >> JOIN("\\n") }}

Screenshot URL: {{ screenshotURL }}`;

export function setup(context) {
  const { register, registerDestination, log } = context;

  register(class CodexPlugin extends context.Plugin {
    static pluginID    = PLUGIN_ID;
    static name        = 'Codex';
    static version     = '0.1.0';
    static description = 'Send Xenocept sessions into a running Codex app-server thread.';
  });

  registerDestination(class CodexDestination extends context.Destination {
    static destinationID = 'org.aeor.xenocept.codex.destination';
    static name          = 'Codex';
    static description   = 'Deliver sessions to Codex via app-server remote control';
    static targetsCodingAgent = true;

    renderConfigUI(container, currentConfig) {
      const { div, label, input, textarea, span, code } = context.elements;
      const config = currentConfig || {};
      const mode = config.mode || 'turn';

      const modeGroup = div.class('form-group')(
        label.class('form-label')('Delivery Mode'),
        div.class('destination-mode-toggle')(
          label.class('destination-mode-option')(
            input.type('radio').name('mode').value('turn')(),
            span(' Send'),
          ),
          label.class('destination-mode-option')(
            input.type('radio').name('mode').value('inject')(),
            span(' Queue'),
          ),
        ),
        div.class('form-hint')(
          'Send makes Codex respond immediately. Queue adds the session as context for a later turn.',
        ),
      ).build(document);
      const turnRadio = modeGroup.querySelector('input[value="turn"]');
      const injectRadio = modeGroup.querySelector('input[value="inject"]');
      if (mode === 'inject') injectRadio.checked = true;
      else turnRadio.checked = true;
      container.appendChild(modeGroup);

      const wsGroup = div.class('form-group')(
        label.class('form-label').for('codex-ws-url')('Codex app-server WebSocket URL'),
        input.class('form-input')
          .type('text')
          .id('codex-ws-url')
          .name('wsURL')
          .placeholder(DEFAULT_WS_URL)
          .value(config.wsURL || DEFAULT_WS_URL)(),
        div.class('form-hint')(
          'For local testing, start Codex app-server with ', code('codex app-server --listen ws://127.0.0.1:14521'), '.',
        ),
      ).build(document);
      container.appendChild(wsGroup);

      const threadPickerGroup = div.class('form-group')(
        label.class('form-label').for('codex-thread-picker')('Codex Session'),
        div.class('form-hint').id('codex-thread-status')(
          'Type a thread ID and press Enter, or open the list to refresh Codex sessions.',
        ),
      ).build(document);

      const threadSelect = document.createElement('aeor-select');
      threadSelect.id = 'codex-thread-picker';
      threadSelect.setAttribute('creatable', '');
      threadSelect.setAttribute('placeholder', 'Type a thread ID and press Enter...');
      threadPickerGroup.insertBefore(threadSelect, threadPickerGroup.querySelector('#codex-thread-status'));

      const threadHidden = document.createElement('input');
      threadHidden.type = 'hidden';
      threadHidden.name = 'threadID';
      threadHidden.id = 'codex-thread-id';
      threadHidden.value = config.threadID || '';
      threadPickerGroup.appendChild(threadHidden);

      container.appendChild(threadPickerGroup);

      container.appendChild(div.class('form-group')(
        label.class('form-label').for('codex-template')('Prompt Template'),
        textarea.class('form-textarea')
          .id('codex-template')
          .name('template')
          .rows('12')
          .title(templateReference())(config.template || DEFAULT_TEMPLATE),
        div.class('form-hint')(
          'Variables match Xenocept destination templates: ',
          code('{{ sessionID }}'), ', ', code('{{ timestamp }}'), ', ',
          code('{{ comments }}'), ', ', code('{{ screenshotURL }}'), ', ',
          code('{{ ocrText }}'), ', ', code('{{ alternativeDescription }}'), '.',
        ),
      ).build(document));

      const wsInput = wsGroup.querySelector('#codex-ws-url');
      const status = threadPickerGroup.querySelector('#codex-thread-status');
      const initialThreadID = (config.threadID || '').trim();

      populateThreadSelect(threadSelect, [], initialThreadID);
      if (initialThreadID) threadSelect.value = initialThreadID;

      const syncThreadHidden = () => {
        threadHidden.value = threadSelect.value || '';
      };

      threadSelect.addEventListener('change', () => {
        syncThreadHidden();
      });

      const loadThreads = createThreadRefreshHandler({
        getWsURL: () => (wsInput.value || DEFAULT_WS_URL).trim(),
        fetchFn: context.fetch,
        selectEl: threadSelect,
        getSelectedThreadID: () => threadHidden.value,
        setSelectedThreadID: (threadID) => {
          threadSelect.value = threadID || '';
          syncThreadHidden();
        },
        setStatus: (message) => {
          status.textContent = message;
        },
        log,
      });

      threadSelect.addEventListener('open', () => {
        loadThreads().catch(() => { /* status is updated in loadThreads */ });
      });
      loadThreads().catch(() => { /* status is updated in loadThreads */ });
    }

    validateConfig(pluginConfig) {
      pluginConfig.mode = pluginConfig.mode === 'inject' ? 'inject' : 'turn';

      const wsURL = (pluginConfig.wsURL || '').trim();
      if (!wsURL) return { valid: false, error: 'Codex WebSocket URL is required' };
      if (!/^wss?:\/\//i.test(wsURL)) {
        return { valid: false, error: 'Codex WebSocket URL must start with ws:// or wss://' };
      }
      pluginConfig.wsURL = wsURL;

      if (typeof pluginConfig.threadID === 'string') {
        pluginConfig.threadID = pluginConfig.threadID.trim();
      }

      return { valid: true };
    }

    async onSend(session, pluginConfig, deliveryContext) {
      const sessionID = session.id;
      if (!sessionID) throw new Error('Session is missing id');

      const fetchFn = typeof context.fetch === 'function' ? context.fetch : fetch;
      const template = pluginConfig.template || DEFAULT_TEMPLATE;
      const rendered = await renderSessionTemplate(fetchFn, template, sessionID, log);

      try {
        const result = await sendToCodex(fetchFn, {
          wsURL: pluginConfig.wsURL || DEFAULT_WS_URL,
          threadID: pluginConfig.threadID || '',
          mode: pluginConfig.mode === 'inject' ? 'inject' : 'turn',
          content: rendered,
        });
        return { success: true, threadID: result.threadID, mode: result.mode };
      } catch (error) {
        const { log: deliveryLog } = deliveryContext || {};
        const logger = deliveryLog || log;
        logger?.error?.('Codex delivery failed:', error);
        throw error;
      }
    }
  });
}

export async function renderSessionTemplate(fetchFn, template, sessionID, log = console) {
  const response = await fetchFn('/api/v1/template/render', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ template, session_id: sessionID }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    log?.warn?.(`Template render HTTP ${response.status}; falling back to raw template`, body);
    return template;
  }

  const json = await response.json();
  return json && typeof json.rendered === 'string' ? json.rendered : '';
}

export function createThreadRefreshHandler({
  getWsURL,
  fetchFn,
  selectEl,
  getSelectedThreadID,
  setSelectedThreadID,
  setStatus,
  log = console,
}) {
  let loading = false;

  return async function refreshCodexThreads() {
    if (loading) return;
    loading = true;
    setStatus?.('Connecting to Codex app-server...');

    try {
      const threads = await loadCodexThreads(fetchFn, getWsURL());
      const selected = getSelectedThreadID?.() || '';
      populateThreadSelect(selectEl, threads, selected);

      if (threads.length === 0) {
        setStatus?.('Connected, but no Codex sessions were found in app-server history.');
      } else if (threads.length === 1) {
        setSelectedThreadID?.(threads[0].id);
        setStatus?.('Found 1 Codex session and selected it.');
      } else {
        if (selected) setSelectedThreadID?.(selected);
        setStatus?.(`Found ${threads.length} Codex sessions. Select the one to receive Xenocept submissions.`);
      }
    } catch (error) {
      setStatus?.(explainConnectionFailure(error));
      log?.warn?.('Could not load Codex sessions:', error);
    } finally {
      loading = false;
    }
  };
}

export async function loadCodexThreads(fetchFn, wsURL) {
  const json = await requestCodexBridge(fetchFn, {
    action: 'list_threads',
    wsURL: wsURL || DEFAULT_WS_URL,
  });
  return Array.isArray(json.threads) ? json.threads : [];
}

export async function sendToCodex(fetchFn, payload) {
  return requestCodexBridge(fetchFn, {
    action: 'send',
    ...(payload || {}),
  });
}

export async function requestCodexBridge(fetchFn, payload, deps = {}) {
  const requestID = deps.requestID || createRequestID();
  const replyChannel = deps.replyChannel || `xenocept-codex-reply-${requestID}`;
  const controlChannel = deps.controlChannel || CONTROL_CHANNEL;
  const timeoutMs = deps.timeoutMs || 10000;
  const openEventSource = deps.openEventSource || ((url) => new EventSource(url));

  await ensureCodexBridge(fetchFn, deps);

  return new Promise((resolve, reject) => {
    const events = openEventSource(`/api/v1/channels/events?name=${encodeURIComponent(replyChannel)}`);
    let settled = false;
    const timer = setTimeout(() => {
      finish();
      reject(new Error('Timed out waiting for Codex plugin bridge response'));
    }, timeoutMs);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { events.close(); } catch (_) { /* ignore */ }
    };

    events.addEventListener('message', (event) => {
      let envelope;
      try {
        envelope = JSON.parse(event.data || '{}');
      } catch (_error) {
        return;
      }
      let body;
      try {
        body = JSON.parse(envelope.content || '{}');
      } catch (_error) {
        return;
      }
      if (body.id !== requestID) return;
      finish();
      if (body.ok === false) {
        reject(new Error(body.error || 'Codex plugin bridge failed'));
      } else {
        resolve(body.result || {});
      }
    });

    events.onerror = () => {
      finish();
      reject(new Error('Lost connection to Codex plugin bridge reply channel'));
    };

    events.onopen = () => {
      send().catch((error) => {
        finish();
        reject(error);
      });
    };

    const send = async () => {
      await postJSON(fetchFn, '/api/v1/channels/send', {
        names: [controlChannel],
        content: JSON.stringify({
          id: requestID,
          replyChannel,
          ...(payload || {}),
        }),
        meta: { pluginID: PLUGIN_ID },
      });
    };
  });
}

export async function ensureCodexBridge(fetchFn, deps = {}) {
  const controlChannel = deps.controlChannel || CONTROL_CHANNEL;
  const bridgeMode = deps.bridgeMode || BRIDGE_MODE;
  const pollMs = deps.pollMs || 150;
  const attempts = deps.attempts || 20;

  if (await channelExists(fetchFn, controlChannel)) return;

  const processes = await fetchJSON(fetchFn, '/api/v1/processes');
  const bridgeRunning = Array.isArray(processes) && processes.some((process) => (
    process?.kind === 'generic' && process?.mode === bridgeMode
  ));

  if (!bridgeRunning) {
    const info = await fetchJSON(fetchFn, '/api/v1/server/info');
    const executablePath = info?.executablePath;
    if (!executablePath) throw new Error('Xenocept server did not report executablePath');
    await postJSON(fetchFn, '/api/v1/processes/generic/spawn', {
      mode: bridgeMode,
      argv: [
        executablePath,
        `plugin://${PLUGIN_ID}/bridge?channel=${encodeURIComponent(controlChannel)}`,
      ],
    });
  }

  for (let i = 0; i < attempts; i += 1) {
    if (await channelExists(fetchFn, controlChannel)) return;
    await sleep(pollMs);
  }
  throw new Error('Codex plugin bridge did not register its control channel');
}

async function channelExists(fetchFn, channel) {
  const names = await fetchJSON(fetchFn, '/api/v1/channels/list');
  return Array.isArray(names) && names.includes(channel);
}

async function fetchJSON(fetchFn, url) {
  const response = await fetchFn(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || `${url}: HTTP ${response.status}`);
  }
  return response.json();
}

async function postJSON(fetchFn, url, body) {
  const response = await fetchFn(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body || {}),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `${url}: HTTP ${response.status}`);
  }
  return response.json().catch(() => ({}));
}

function createRequestID() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resolveThreadID(client, configuredThreadID) {
  const explicit = typeof configuredThreadID === 'string' ? configuredThreadID.trim() : '';
  if (explicit) return explicit;

  const available = await client.availableThreads();
  if (available.length === 1) return available[0].id;
  if (available.length === 0) {
    throw new Error('No Codex sessions found. Start Codex app-server or configure Thread ID explicitly.');
  }
  throw new Error(`Multiple Codex sessions found (${available.length}). Configure Thread ID explicitly.`);
}

export function formatThreadLabel(thread) {
  const id = thread?.id || '';
  const cwd = (thread?.cwd || '').trim();
  return cwd || id;
}

export function buildThreadOptions(threads, selectedThreadID = '') {
  const options = [];
  const seen = new Set();
  const labelCounts = new Map();
  const selected = (selectedThreadID || '').trim();

  for (const thread of Array.isArray(threads) ? threads : []) {
    const label = formatThreadLabel(thread);
    if (!label) continue;
    labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
  }

  for (const thread of Array.isArray(threads) ? threads : []) {
    if (!thread?.id || seen.has(thread.id)) continue;
    seen.add(thread.id);
    const label = formatThreadLabel(thread);
    const disambiguated = labelCounts.get(label) > 1
      ? `${label} (${shortThreadID(thread.id)})`
      : label;
    options.push({ value: thread.id, label: disambiguated });
  }

  if (selected && !seen.has(selected)) {
    options.unshift({ value: selected, label: selected });
  }

  return options;
}

function shortThreadID(id) {
  const value = String(id || '');
  return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

export function populateThreadSelect(selectEl, threads, selectedThreadID = '') {
  const options = buildThreadOptions(threads, selectedThreadID);
  selectEl.setOptions(options);
  if (selectedThreadID && options.some((opt) => opt.value === selectedThreadID)) {
    selectEl.value = selectedThreadID;
  }
}

export function explainConnectionFailure(error) {
  const message = String(error?.message || error || '');
  if (/connect|websocket|closed before opening|timed out/i.test(message)) {
    return [
      'Could not connect to Codex app-server.',
      'Start it with: codex app-server --listen ws://127.0.0.1:14521',
      'The standalone remote-control command is nicer when installed, but this local app-server command is enough for testing.',
    ].join(' ');
  }
  return `Could not load Codex sessions: ${message}`;
}

export function buildTurnInput(text) {
  return [{ type: 'text', text: String(text || '') }];
}

export function buildInjectedUserItems(text) {
  return [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: String(text || '') }],
  }];
}

export class CodexAppServerClient {
  constructor({ wsURL, authToken = '', WebSocketImpl = globalThis.WebSocket, timeoutMs = 10000 }) {
    if (!WebSocketImpl) throw new Error('WebSocket is not available');
    this.wsURL = wsURL;
    this.authToken = authToken;
    this.WebSocketImpl = WebSocketImpl;
    this.timeoutMs = timeoutMs;
    this.ws = null;
    this.nextID = 1;
    this.pending = new Map();
  }

  async connect() {
    const protocols = this.authToken ? ['bearer', this.authToken] : undefined;
    this.ws = protocols
      ? new this.WebSocketImpl(this.wsURL, protocols)
      : new this.WebSocketImpl(this.wsURL);

    await waitForOpen(this.ws, this.timeoutMs);
    await this.request('initialize', {
      clientInfo: {
        name: 'xenocept-plugin-aeor-codex',
        title: 'Xenocept Codex Destination',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify('initialized');
  }

  loadedThreadIDs() {
    return this.request('thread/loaded/list', { limit: 25 }).then((result) => {
      const data = result && Array.isArray(result.data) ? result.data : [];
      return data.filter((id) => typeof id === 'string' && id.length > 0);
    });
  }

  async availableThreads() {
    const result = await this.request('thread/list', { limit: 50 });
    const data = result && Array.isArray(result.data) ? result.data : [];
    return data
      .filter((thread) => thread && typeof thread.id === 'string' && thread.id.length > 0)
      .map((thread) => ({
        id: thread.id,
        title: typeof thread.title === 'string' ? thread.title : '',
        name: typeof thread.name === 'string' ? thread.name : '',
        preview: typeof thread.preview === 'string' ? thread.preview : '',
        cwd: typeof thread.cwd === 'string' ? thread.cwd : '',
        status: typeof thread.status?.type === 'string' ? thread.status.type : '',
      }));
  }

  async resumeThread(threadID) {
    if (!threadID) throw new Error('threadID is required');
    try {
      await this.request('thread/resume', {
        threadId: threadID,
        includeTurns: false,
      });
    } catch (error) {
      const message = String(error?.message || error || '');
      if (!/already loaded|active|loaded/i.test(message)) {
        throw error;
      }
    }
  }

  startTurn(threadID, text) {
    return this.request('turn/start', {
      threadId: threadID,
      input: buildTurnInput(text),
    });
  }

  injectItems(threadID, items) {
    return this.request('thread/inject_items', {
      threadId: threadID,
      items,
    });
  }

  request(method, params = {}) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error('Codex app-server WebSocket is not open'));
    }

    const id = this.nextID++;
    const payload = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify(payload));

      if (!this.ws._xenoceptCodexOnMessageInstalled) {
        const prev = this.ws.onmessage;
        this.ws.onmessage = (event) => {
          if (typeof prev === 'function') prev.call(this.ws, event);
          this._handleMessage(event.data);
        };
        this.ws._xenoceptCodexOnMessageInstalled = true;
      }
    });
  }

  notify(method, params) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const payload = params === undefined
      ? { jsonrpc: '2.0', method }
      : { jsonrpc: '2.0', method, params };
    this.ws.send(JSON.stringify(payload));
  }

  close() {
    if (this.ws && this.ws.readyState <= 1) {
      this.ws.close();
    }
    this.ws = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex app-server WebSocket closed'));
    }
    this.pending.clear();
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw));
    } catch (_error) {
      return;
    }

    if (msg.id === undefined || !this.pending.has(msg.id)) return;
    const pending = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);

    if (msg.error) {
      const message = msg.error.message || `Codex app-server ${pending.method} failed`;
      pending.reject(new Error(message));
    } else {
      pending.resolve(msg.result || {});
    }
  }
}

function waitForOpen(ws, timeoutMs) {
  if (ws.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out connecting to Codex app-server WebSocket'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ws.onopen = null;
      ws.onerror = null;
      ws.onclose = null;
    };

    ws.onopen = () => {
      cleanup();
      resolve();
    };
    ws.onerror = () => {
      cleanup();
      reject(new Error('Failed to connect to Codex app-server WebSocket'));
    };
    ws.onclose = () => {
      cleanup();
      reject(new Error('Codex app-server WebSocket closed before opening'));
    };
  });
}

function templateReference() {
  return [
    'Template syntax: {{ name }} for variables, with EACH/JOIN modifiers for arrays.',
    '',
    'Common variables:',
    '  sessionID',
    '  timestamp',
    '  commentCount',
    '  comments',
    '  screenshotURL',
    '  ocrText',
    '  alternativeDescription',
  ].join('\n');
}

export const __test = {
  DEFAULT_TEMPLATE,
  DEFAULT_WS_URL,
  CONTROL_CHANNEL,
  BRIDGE_MODE,
  templateReference,
};
