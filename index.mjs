'use strict';

const PLUGIN_ID = 'org.aeor.xenocept.codex';
const DESTINATION_ID = 'org.aeor.xenocept.codex.destination';
const DEFAULT_WS_URL = 'ws://127.0.0.1:14521';
const CONTROL_CHANNEL = 'xenocept-codex-control';
const BRIDGE_MODE = 'xenocept-codex-bridge';
const DIRECTORY_ID = 'xenocept-plugin-aeor-codex';
const DEFAULT_OCR_MODEL = 'gpt-5.4-mini';
const DEFAULT_OCR_TIMEOUT_SECONDS = 60;
const KNOWN_OCR_MODELS = [
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.4',
  'gpt-5.5',
];
const OCR_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    ocr_text:                { type: 'string' },
    alternative_description: { type: 'string' },
  },
  required: ['ocr_text', 'alternative_description'],
  additionalProperties: false,
};
const deliveredAutoSendKeys = new Set();
let autoSendListenerRegistered = false;
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

const OCR_PROMPT = [
  'You will analyze a screen capture and produce a JSON object with exactly two string fields.',
  '',
  '"ocr_text":',
  '  Transcribe ALL visible text in the image: every word, label, button text, menu item,',
  '  filename, URL, code, error message, tooltip, watermark, and anything literal.',
  '  Concatenate everything into one block of text in natural reading order',
  '  (top-to-bottom, left-to-right; group by logical region: window, panel, dialog).',
  '  Preserve casing and punctuation. Use newlines between distinct regions for clarity.',
  '  Do NOT include descriptions, formatting, or markdown. Just the literal text.',
  '  If the image contains no readable text, return an empty string.',
  '',
  '"alternative_description":',
  '  Describe the image in dense, analytical detail. The output is used for full-text indexing,',
  '  so optimize for SEARCH RECALL: concrete nouns, identifiable applications, named UI',
  '  elements, recognizable objects, file types, languages, frameworks, brand names.',
  '  Specifically include, when visible:',
  '    - The application/program/website (for example Visual Studio Code, Slack, Firefox showing',
  '      github.com, macOS Finder, or GIMP image editor). Identify it specifically; if',
  '      uncertain, give your best guess and a runner-up.',
  '    - The window/panel layout (sidebar, tabs, modal, toolbar, status bar).',
  '    - Domain content: code language, repo/file paths, document type, chart type, app screen.',
  '    - Imagery: name objects/people/scenes if photos are present.',
  '    - Theme colors only if distinctive (dark vs light, dominant accent color).',
  '  Do NOT use storytelling language, mood adjectives, or aesthetic commentary.',
  '  Be exhaustive on facts, terse on prose. Multiple sentences are fine; bullet points are not.',
  '',
  'Respond with strict JSON: { "ocr_text": "...", "alternative_description": "..." }.',
  'No markdown fences, no commentary outside the JSON.',
].join('\n');

export function setup(context) {
  const { register, registerDestination, log } = context;
  const fetchFn = typeof context.fetch === 'function' ? context.fetch : fetch;
  const elements = context.elements;
  const aeorCheckbox = elements['aeor-checkbox'];

  register(class CodexPlugin extends context.Plugin {
    static pluginID    = PLUGIN_ID;
    static name        = 'Codex';
    static version     = '0.2.0';
    static description = 'Send Xenocept sessions into a running Codex app-server thread, and optionally run OpenAI vision OCR for screenshot enrichment.';
    static role        = 'ocr';

    constructor(ctx) {
      super(ctx);
      this._inflight = 0;
      this._maxInflight = 1;
    }

    async renderConfigUI(container, currentConfig) {
      const { div, label, input, p, code, option } = context.elements;
      const aeorSelect = context.elements['aeor-select'];
      const cfg = currentConfig || {};
      const ocrEnabled = cfg.ocr_enabled === true;
      const apiKeyValue = cfg.ocr_api_key || '';
      const modelValue = (cfg.ocr_model || DEFAULT_OCR_MODEL).trim();
      const modelOptions = KNOWN_OCR_MODELS.includes(modelValue)
        ? KNOWN_OCR_MODELS
        : [modelValue, ...KNOWN_OCR_MODELS];
      const timeoutSeconds = normalizeOcrTimeoutSeconds(cfg.ocr_timeout_seconds);

      let enabledCheckbox = aeorCheckbox.name('ocr_enabled').id('codex-ocr-enabled');
      if (ocrEnabled) enabledCheckbox = enabledCheckbox.checked('');
      container.appendChild(div.class('form-group')(
        enabledCheckbox('Enable Codex OCR'),
        div.class('settings-hint')(
          'When enabled, every new session screenshot is sent to the OpenAI Responses API.',
          ' The result is written back as ', code('ocr_text'), ' and ',
          code('alternative_description'), ' for Xenocept search.',
        ),
      ).build(document));

      container.appendChild(div.class('form-group')(
        label.class('form-label').for('codex-ocr-api-key')('OpenAI API key'),
        input.class('form-input')
          .type('password')
          .id('codex-ocr-api-key')
          .name('ocr_api_key')
          .placeholder('sk-...')
          .value(apiKeyValue)(),
        div.class('settings-hint')(
          'Stored in Xenocept\'s local database; transmitted only to ', code('api.openai.com'),
          '. The Codex destination can still use app-server, but OCR does not require the Codex CLI.',
        ),
      ).build(document));

      container.appendChild(div.class('form-group')(
        label.class('form-label').for('codex-ocr-model')('Vision model'),
        aeorSelect
          .id('codex-ocr-model')
          .name('ocr_model')
          .placeholder(DEFAULT_OCR_MODEL)
          .value(modelValue)(
            ...modelOptions.map((model) => option.value(model)(model)),
          ),
        div.class('settings-hint')(
          'Default ', code(DEFAULT_OCR_MODEL), ' balances cost and latency for per-screenshot OCR.',
          ' Use ', code('gpt-5.5'), ' when accuracy on dense screenshots matters more than cost.',
        ),
      ).build(document));

      container.appendChild(div.class('form-group')(
        label.class('form-label').for('codex-ocr-timeout')('OCR timeout'),
        input.class('form-input')
          .type('number')
          .id('codex-ocr-timeout')
          .name('ocr_timeout_seconds')
          .min('15')
          .max('300')
          .step('5')
          .value(String(timeoutSeconds))(),
        div.class('settings-hint')(
          'Seconds to wait for OpenAI before falling through to the next OCR plugin.',
        ),
      ).build(document));

      container.appendChild(p.class('plugin-marketplace-notice')(
        'OCR is opt-in. Costs accrue to your OpenAI account at the selected model\'s rate. API requests use store=false.',
      ).build(document));

      await this._renderOcrMasterControl(container);
    }

    async _renderOcrMasterControl(container) {
      const { div } = context.elements;
      const aeorConfirmButton = context.elements['aeor-confirm-button'];
      const aeorInfoBox = context.elements['aeor-info-box'];

      let currentMasterID = null;
      try { currentMasterID = await context.getOcrMaster?.(); } catch { /* ignore */ }
      const amMaster = currentMasterID === DIRECTORY_ID;

      let confirmBtn = aeorConfirmButton
        .label(amMaster ? 'OCR master (current)' : 'Hold to make OCR master')
        .confirmedText('Now OCR master ✓')
        .ariaLabel(amMaster
          ? 'This plugin is already the OCR master'
          : 'Hold to make Codex the OCR master');
      if (amMaster) {
        confirmBtn = confirmBtn.disabled('');
      } else {
        confirmBtn = confirmBtn.onConfirm(async () => {
          try {
            await context.setOcrMaster(DIRECTORY_ID);
            log?.info?.('promoted to OCR master');
          } catch (error) {
            log?.warn?.('failed to promote to OCR master:', error);
          }
        });
      }

      container.appendChild(div.class('form-group')(
        confirmBtn(),
        aeorInfoBox.kind(amMaster ? 'success' : 'info')(
          amMaster
            ? 'This plugin is the current OCR master. It runs first on every session; other OCR plugins are slaves and only run if it fails. To swap, open another OCR plugin\'s Configure page and hold its master button.'
            : 'OCR runs in a master/slave chain. The master tries first on every session; if it returns no result or fails, the loader falls through to slaves in install order. Hold the button above to make this plugin the master.',
        ),
      ).build(document));
    }

    async _loadConfig() {
      const reqOpts = { referrer: import.meta.url };
      try {
        const r = await fetch(`/api/v1/plugins/npm/${encodeURIComponent(DIRECTORY_ID)}/config`, reqOpts);
        if (r.ok) return await r.json();

        const fallback = await fetch(`/api/v1/plugins/npm/${encodeURIComponent(PLUGIN_ID)}/config`, reqOpts);
        return fallback.ok ? await fallback.json() : {};
      } catch (error) {
        log?.warn?.('failed to read Codex plugin config:', error);
        return {};
      }
    }

    async onOcr({ sessionID }) {
      if (!sessionID) return null;
      if (this._inflight >= this._maxInflight) {
        log?.info?.('skipping — another Codex OCR call is already in flight');
        return null;
      }

      const config = await this._loadConfig();
      if (config.ocr_enabled !== true) return null;

      const apiKey = (config.ocr_api_key || '').trim();
      if (!apiKey) return null;

      try {
        const r = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionID)}/meta`, {
          referrer: import.meta.url,
        });
        if (r.ok) {
          const meta = await r.json();
          const existing = typeof meta?.alternative_description === 'string'
            ? meta.alternative_description.trim()
            : '';
          if (existing.length > 0) {
            log?.info?.(`skipping — session ${sessionID} already has alternative_description`);
            return null;
          }
        }
      } catch (error) {
        log?.warn?.('alt-description idempotency check failed:', error);
      }

      this._inflight += 1;
      try {
        const { ocrText, altDescription } = await extractOpenAIOcr(fetchFn, sessionID, config, log);
        if (!ocrText && !altDescription) return null;
        return {
          ocr_text:                ocrText,
          alternative_description: altDescription,
        };
      } finally {
        this._inflight -= 1;
      }
    }

    async preferredOcrPhase() {
      return 'processing';
    }
  });

  if (!autoSendListenerRegistered) {
    autoSendListenerRegistered = true;
    context.on?.('submit-done-processing', async ({ sessionID } = {}) => {
      try {
        await handleCodexAutoSend({
          fetchFn,
          sessionID,
          deliveredKeys: deliveredAutoSendKeys,
          log,
        });
      } catch (error) {
        log?.error?.('Codex auto-send failed:', error);
      }
    });
  }

  registerDestination(class CodexDestination extends context.Destination {
    static destinationID = DESTINATION_ID;
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

      try {
        const result = await deliverCodexSession(fetchFn, sessionID, pluginConfig, log);
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

export async function handleCodexAutoSend({
  fetchFn,
  sessionID,
  deliveredKeys = new Set(),
  log = console,
}) {
  if (!sessionID) return { sent: 0, failed: 0, skipped: 0 };

  const autoSend = await fetchJSON(fetchFn, '/api/v1/auto-send');
  if (!autoSend?.enabled) return { sent: 0, failed: 0, skipped: 0 };

  const autoDestinationIDs = new Set(Array.isArray(autoSend.destinationIDs)
    ? autoSend.destinationIDs
    : []);
  if (autoDestinationIDs.size === 0) return { sent: 0, failed: 0, skipped: 0 };

  const destinations = await fetchJSON(fetchFn, '/api/v1/destinations');
  const codexDestinations = Array.isArray(destinations)
    ? destinations.filter((destination) => (
      destination
      && destination.enabled !== false
      && destination.pluginID === DESTINATION_ID
      && autoDestinationIDs.has(destination.id)
    ))
    : [];

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const destination of codexDestinations) {
    const key = `${sessionID}:${destination.id}`;
    if (deliveredKeys.has(key)) {
      skipped += 1;
      continue;
    }

    deliveredKeys.add(key);
    try {
      await deliverCodexSession(fetchFn, sessionID, destination.pluginConfig || {}, log);
      sent += 1;
    } catch (error) {
      deliveredKeys.delete(key);
      failed += 1;
      log?.error?.(`Codex auto-send failed for destination ${destination.id}:`, error);
    }
  }

  if (sent || failed || skipped) {
    log?.info?.(`Codex auto-send session=${sessionID} sent=${sent} failed=${failed} skipped=${skipped}`);
  }

  return { sent, failed, skipped };
}

export async function deliverCodexSession(fetchFn, sessionID, pluginConfig = {}, log = console) {
  const template = pluginConfig.template || DEFAULT_TEMPLATE;
  const rendered = await renderSessionTemplate(fetchFn, template, sessionID, log);

  return sendToCodex(fetchFn, {
    wsURL: pluginConfig.wsURL || DEFAULT_WS_URL,
    threadID: pluginConfig.threadID || '',
    mode: pluginConfig.mode === 'inject' ? 'inject' : 'turn',
    content: rendered,
  });
}

export async function extractOpenAIOcr(fetchFn, sessionID, pluginConfig = {}, log = console) {
  const apiKey = (pluginConfig.ocr_api_key || '').trim();
  if (!apiKey) return { ocrText: '', altDescription: '' };

  const imageURL = `/api/v1/sessions/${encodeURIComponent(sessionID)}/files/screenshot.png`;
  const imageResponse = await fetchFn(imageURL);
  if (!imageResponse.ok) throw new Error(`screenshot ${imageResponse.status}`);

  const bytes = new Uint8Array(await imageResponse.arrayBuffer());
  const body = buildOpenAIOcrRequest({
    model: pluginConfig.ocr_model || DEFAULT_OCR_MODEL,
    imageBase64: bytesToBase64(bytes),
  });
  const timeoutMs = normalizeOcrTimeoutSeconds(pluginConfig.ocr_timeout_seconds) * 1000;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`openai ${response.status}: ${errorBody.slice(0, 300)}`);
    }

    const json = await response.json();
    return parseOpenAIOcrResponse(json);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`openai OCR timed out after ${timeoutMs / 1000}s`);
    }
    log?.warn?.('OpenAI OCR failed:', error);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function buildOpenAIOcrRequest({ model, imageBase64 }) {
  return {
    model: String(model || DEFAULT_OCR_MODEL).trim() || DEFAULT_OCR_MODEL,
    store: false,
    max_output_tokens: 8192,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: OCR_PROMPT },
        {
          type: 'input_image',
          image_url: `data:image/png;base64,${imageBase64 || ''}`,
        },
      ],
    }],
    text: {
      format: {
        type:   'json_schema',
        name:   'xenocept_ocr_result',
        strict: true,
        schema: OCR_RESPONSE_SCHEMA,
      },
    },
  };
}

export function parseOpenAIOcrResponse(json) {
  const rawText = extractResponseOutputText(json).trim();
  if (!rawText) return { ocrText: '', altDescription: '' };

  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_error) {
    throw new Error(`openai returned non-JSON: ${cleaned.slice(0, 200)}`);
  }

  return {
    ocrText:        typeof parsed.ocr_text === 'string' ? parsed.ocr_text : '',
    altDescription: typeof parsed.alternative_description === 'string'
      ? parsed.alternative_description
      : '',
  };
}

export function extractResponseOutputText(json) {
  if (typeof json?.output_text === 'string') return json.output_text;

  const chunks = [];
  for (const item of Array.isArray(json?.output) ? json.output : []) {
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string') chunks.push(part.text);
      else if (typeof part.output_text === 'string') chunks.push(part.output_text);
    }
  }
  return chunks.join('');
}

export function normalizeOcrTimeoutSeconds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_OCR_TIMEOUT_SECONDS;
  return Math.max(15, Math.min(300, Math.round(parsed)));
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

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
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
        version: '0.2.0',
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
  DEFAULT_OCR_MODEL,
  DEFAULT_WS_URL,
  CONTROL_CHANNEL,
  BRIDGE_MODE,
  OCR_RESPONSE_SCHEMA,
  templateReference,
};
