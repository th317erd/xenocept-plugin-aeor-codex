'use strict';

const PLUGIN_ID = 'org.aeor.xenocept.codex';
const DEFAULT_WS_URL = 'ws://127.0.0.1:14521';
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
      const { div, label, input, textarea, button, select, option, span, code } = context.elements;
      const config = currentConfig || {};
      const mode = config.mode || 'turn';

      const modeGroup = div.class('form-group')(
        label.class('form-label')('Delivery Mode'),
        div.class('destination-mode-toggle')(
          label.class('destination-mode-option')(
            input.type('radio').name('mode').value('turn')(),
            span(' Start turn'),
          ),
          label.class('destination-mode-option')(
            input.type('radio').name('mode').value('inject')(),
            span(' Inject context'),
          ),
        ),
        div.class('form-hint')(
          'Start turn makes Codex respond immediately. Inject context only appends model-visible history for a later turn.',
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
          'Run ', code('codex remote-control start --json'), ' and paste the WebSocket URL here.',
        ),
      ).build(document);
      container.appendChild(wsGroup);

      const authGroup = div.class('form-group')(
        label.class('form-label').for('codex-auth-token')('Auth token'),
        input.class('form-input')
          .type('password')
          .id('codex-auth-token')
          .name('authToken')
          .placeholder('Optional bearer/capability token')
          .value(config.authToken || '')(),
      ).build(document);
      container.appendChild(authGroup);

      const threadGroup = div.class('form-group')(
        label.class('form-label').for('codex-thread-id')('Thread ID'),
        input.class('form-input')
          .type('text')
          .id('codex-thread-id')
          .name('threadID')
          .placeholder('Blank = use the only loaded Codex thread')
          .value(config.threadID || '')(),
        div.class('form-hint')(
          'Pick from loaded Codex sessions below, or paste a thread ID manually.',
        ),
      ).build(document);
      container.appendChild(threadGroup);

      const threadPickerGroup = div.class('form-group')(
        label.class('form-label').for('codex-thread-picker')('Loaded Codex Sessions'),
        select.class('form-select').id('codex-thread-picker')(
          option.value('')('Click Load to discover sessions'),
        ),
        button.class('secondary').type('button').id('codex-load-threads')('Load active Codex sessions'),
        div.class('form-hint').id('codex-thread-status')(
          'Uses the WebSocket URL above to list Codex threads currently loaded in app-server.',
        ),
      ).build(document);
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
      const authInput = authGroup.querySelector('#codex-auth-token');
      const threadInput = threadGroup.querySelector('#codex-thread-id');
      const threadPicker = threadPickerGroup.querySelector('#codex-thread-picker');
      const loadButton = threadPickerGroup.querySelector('#codex-load-threads');
      const status = threadPickerGroup.querySelector('#codex-thread-status');

      threadPicker.addEventListener('change', () => {
        if (threadPicker.value) threadInput.value = threadPicker.value;
      });

      loadButton.addEventListener('click', async () => {
        loadButton.disabled = true;
        status.textContent = 'Connecting to Codex app-server...';
        const client = new CodexAppServerClient({
          wsURL: (wsInput.value || DEFAULT_WS_URL).trim(),
          authToken: authInput.value || '',
          WebSocketImpl: globalThis.WebSocket,
          timeoutMs: 5000,
        });

        try {
          await client.connect();
          const threads = await client.loadedThreads();
          replaceThreadPickerOptions(threadPicker, threads, document);

          if (threads.length === 0) {
            status.textContent = 'No loaded Codex sessions found. Open a Codex session, then load again.';
          } else if (threads.length === 1) {
            threadPicker.value = threads[0].id;
            threadInput.value = threads[0].id;
            status.textContent = 'Found 1 loaded Codex session and selected it.';
          } else {
            status.textContent = `Found ${threads.length} loaded Codex sessions. Select the one to receive Xenocept submissions.`;
          }
        } catch (error) {
          status.textContent = `Could not load Codex sessions: ${error.message || error}`;
        } finally {
          client.close();
          loadButton.disabled = false;
        }
      });
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

      const client = new CodexAppServerClient({
        wsURL: pluginConfig.wsURL || DEFAULT_WS_URL,
        authToken: pluginConfig.authToken || '',
        WebSocketImpl: globalThis.WebSocket,
      });

      try {
        await client.connect();
        const threadID = await resolveThreadID(client, pluginConfig.threadID);
        if (pluginConfig.mode === 'inject') {
          await client.injectItems(threadID, buildInjectedUserItems(rendered));
          return { success: true, threadID, mode: 'inject' };
        }

        await client.startTurn(threadID, rendered);
        return { success: true, threadID, mode: 'turn' };
      } catch (error) {
        const { log: deliveryLog } = deliveryContext || {};
        const logger = deliveryLog || log;
        logger?.error?.('Codex delivery failed:', error);
        throw error;
      } finally {
        client.close();
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

export async function resolveThreadID(client, configuredThreadID) {
  const explicit = typeof configuredThreadID === 'string' ? configuredThreadID.trim() : '';
  if (explicit) return explicit;

  const loaded = await client.loadedThreadIDs();
  if (loaded.length === 1) return loaded[0];
  if (loaded.length === 0) {
    throw new Error('No loaded Codex threads. Open a Codex session or configure Thread ID explicitly.');
  }
  throw new Error(`Multiple loaded Codex threads (${loaded.length}). Configure Thread ID explicitly.`);
}

export function formatThreadLabel(thread) {
  const id = thread?.id || '';
  const title = (thread?.title || thread?.name || '').trim();
  const cwd = (thread?.cwd || '').trim();
  const shortID = id.length > 16 ? `${id.slice(0, 8)}...${id.slice(-6)}` : id;
  if (title && cwd) return `${title} - ${cwd} (${shortID})`;
  if (title) return `${title} (${shortID})`;
  if (cwd) return `${cwd} (${shortID})`;
  return id;
}

export function replaceThreadPickerOptions(selectEl, threads, doc = document) {
  while (selectEl.firstChild) selectEl.removeChild(selectEl.firstChild);

  if (!Array.isArray(threads) || threads.length === 0) {
    const opt = doc.createElement('option');
    opt.value = '';
    opt.textContent = 'No loaded Codex sessions';
    selectEl.appendChild(opt);
    return;
  }

  for (const thread of threads) {
    const opt = doc.createElement('option');
    opt.value = thread.id;
    opt.textContent = formatThreadLabel(thread);
    selectEl.appendChild(opt);
  }
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

  async loadedThreads() {
    const ids = await this.loadedThreadIDs();
    const out = [];
    for (const id of ids) {
      try {
        const result = await this.request('thread/read', {
          threadId: id,
          includeTurns: false,
        });
        const thread = result && result.thread && typeof result.thread === 'object'
          ? result.thread
          : {};
        out.push({
          id,
          title: typeof thread.title === 'string' ? thread.title : '',
          name: typeof thread.name === 'string' ? thread.name : '',
          cwd: typeof thread.cwd === 'string' ? thread.cwd : '',
          status: typeof thread.status === 'string' ? thread.status : '',
        });
      } catch (_error) {
        out.push({ id });
      }
    }
    return out;
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
  templateReference,
};
