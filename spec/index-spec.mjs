import assert from 'node:assert/strict';
import {
  CodexAppServerClient,
  buildModelOptions,
  buildThreadOptions,
  buildInjectedUserItems,
  buildTurnInput,
  createModelRefreshHandler,
  createThreadRefreshHandler,
  handleCodexAutoSend,
  explainConnectionFailure,
  formatThreadLabel,
  loadCodexModels,
  loadCodexThreads,
  populateModelSelect,
  populateThreadSelect,
  requestCodexBridge,
  renderSessionTemplate,
  resolveThreadID,
  sendToCodex,
} from '../index.mjs';

class FakeWebSocket {
  static instances = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(raw) {
    const msg = JSON.parse(raw);
    this.sent.push(msg);
    if (msg.id) {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: FakeWebSocket.responseFor(msg),
          }),
        });
      });
    }
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

FakeWebSocket.responseFor = (msg) => {
  if (msg.method === 'initialize') return { userAgent: 'codex-test', codexHome: '/tmp/codex', platformFamily: 'unix', platformOs: 'linux' };
  if (msg.method === 'thread/loaded/list') return { data: ['thread-1'] };
  if (msg.method === 'thread/read') return { thread: { id: msg.params.threadId, title: 'Main task', cwd: '/repo' } };
  if (msg.method === 'thread/list') return { data: [{ id: 'thread-1', preview: 'Main task', cwd: '/repo', status: { type: 'notLoaded' } }] };
  if (msg.method === 'thread/resume') return { thread: { id: msg.params.threadId, status: { type: 'idle' } } };
  if (msg.method === 'turn/start') return { turn: { id: 'turn-1' } };
  if (msg.method === 'thread/inject_items') return {};
  return {};
};

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function createBridgeHarness(resultForRequest) {
  const sent = [];
  const sources = new Map();

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      sources.set(url, this);
      queueMicrotask(() => this.onopen?.());
    }

    addEventListener(type, fn) {
      this.listeners.set(type, fn);
    }

    emit(type, data) {
      this.listeners.get(type)?.({ data });
    }

    close() {
      this.closed = true;
    }
  }

  const fetchFn = async (url, options = {}) => {
    sent.push({ url, options });
    if (url === '/api/v1/channels/list') {
      return { ok: true, json: async () => ['xenocept-codex-control'] };
    }
    if (url === '/api/v1/processes') {
      return { ok: true, json: async () => [] };
    }
    if (url === '/api/v1/channels/send') {
      const body = JSON.parse(options.body);
      const request = JSON.parse(body.content);
      let ok = true;
      let result;
      try {
        result = resultForRequest(request);
      } catch (error) {
        ok = false;
        result = error?.message || String(error);
      }
      const source = sources.get(`/api/v1/channels/events?name=${encodeURIComponent(request.replyChannel)}`);
      queueMicrotask(() => {
        source?.emit('message', JSON.stringify({
          content: JSON.stringify(ok
            ? { id: request.id, ok: true, result }
            : { id: request.id, ok: false, error: result }),
          meta: {},
        }));
      });
      return { ok: true, json: async () => ({ delivered: body.names, missing: [] }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  return { fetchFn, FakeEventSource, sent };
}

test('buildTurnInput emits Codex text input shape', () => {
  assert.deepEqual(buildTurnInput('hello'), [{ type: 'text', text: 'hello' }]);
  assert.deepEqual(buildTurnInput(null), [{ type: 'text', text: '' }]);
});

test('buildInjectedUserItems emits Responses user message shape', () => {
  assert.deepEqual(buildInjectedUserItems('ctx'), [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'ctx' }],
  }]);
});

test('buildModelOptions uses visible Codex models and preserves saved selection', () => {
  assert.deepEqual(buildModelOptions([
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { slug: 'gpt-hidden', display_name: 'Hidden', hidden: true },
    { slug: 'gpt-5.4', display_name: 'GPT-5.4' },
  ], 'gpt-custom'), [
    { value: 'gpt-custom', label: 'gpt-custom' },
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'gpt-5.4', label: 'GPT-5.4' },
  ]);
});

test('populateModelSelect uses aeor-select API and restores selection', () => {
  const calls = [];
  const selectEl = {
    value: '',
    setOptions(options) {
      calls.push(options);
    },
  };

  populateModelSelect(selectEl, [{ id: 'gpt-5.5', label: 'GPT-5.5' }], 'gpt-5.5');

  assert.deepEqual(calls[0], [{ value: 'gpt-5.5', label: 'GPT-5.5' }]);
  assert.equal(selectEl.value, 'gpt-5.5');
});

test('populateModelSelect fills native select options', () => {
  const children = [];
  const selectEl = {
    firstChild: null,
    ownerDocument: {
      createElement(tag) {
        assert.equal(tag, 'option');
        return { value: '', textContent: '' };
      },
    },
    appendChild(child) {
      children.push(child);
      this.firstChild = null;
    },
    removeChild() {
      throw new Error('should not remove without children');
    },
  };

  populateModelSelect(selectEl, [
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
  ], 'gpt-5.4');

  assert.deepEqual(children, [
    { value: 'gpt-5.5', textContent: 'GPT-5.5' },
    { value: 'gpt-5.4', textContent: 'GPT-5.4' },
  ]);
  assert.equal(selectEl.value, 'gpt-5.4');
});

test('formatThreadLabel uses the session working directory', () => {
  assert.equal(formatThreadLabel({ id: 'thread-1234567890abcdef', title: 'Main task', cwd: '/repo' }), '/repo');
  assert.equal(formatThreadLabel({ id: 'thread-1', cwd: '/repo' }), '/repo');
  assert.equal(formatThreadLabel({ id: 'thread-1' }), 'thread-1');
});

test('buildThreadOptions preserves selected manual value and loaded sessions', () => {
  assert.deepEqual(buildThreadOptions([], 'manual-thread'), [
    { value: 'manual-thread', label: 'manual-thread' },
  ]);

  assert.deepEqual(buildThreadOptions([
    { id: 'thread-1', title: 'Main' },
    { id: 'thread-2', cwd: '/repo' },
  ], 'thread-1'), [
    { value: 'thread-1', label: 'thread-1' },
    { value: 'thread-2', label: '/repo' },
  ]);
});

test('buildThreadOptions only adds IDs to duplicate directories', () => {
  assert.deepEqual(buildThreadOptions([
    { id: 'thread-1234567890abcdef', cwd: '/repo' },
    { id: 'thread-fedcba0987654321', cwd: '/repo' },
  ]), [
    { value: 'thread-1234567890abcdef', label: '/repo (thread-1...abcdef)' },
    { value: 'thread-fedcba0987654321', label: '/repo (thread-f...654321)' },
  ]);
});

test('populateThreadSelect uses aeor-select API and restores selection', () => {
  const calls = [];
  const selectEl = {
    value: '',
    setOptions(options) {
      calls.push(options);
    },
  };

  populateThreadSelect(selectEl, [{ id: 'thread-1', title: 'Main' }], 'thread-1');
  assert.deepEqual(calls[0], [{ value: 'thread-1', label: 'thread-1' }]);
  assert.equal(selectEl.value, 'thread-1');
});

test('explainConnectionFailure gives actionable app-server setup', () => {
  const msg = explainConnectionFailure(new Error('Failed to connect to Codex app-server WebSocket'));
  assert.match(msg, /codex app-server --listen ws:\/\/127\.0\.0\.1:14521/);
});

test('renderSessionTemplate returns rendered body', async () => {
  const fetchFn = async (_url, options) => {
    assert.equal(JSON.parse(options.body).session_id, 'session-1');
    return {
      ok: true,
      json: async () => ({ rendered: 'rendered prompt' }),
    };
  };
  const rendered = await renderSessionTemplate(fetchFn, 'template', 'session-1');
  assert.equal(rendered, 'rendered prompt');
});

test('renderSessionTemplate falls back on server error', async () => {
  const fetchFn = async () => ({
    ok: false,
    status: 500,
    text: async () => 'boom',
  });
  const rendered = await renderSessionTemplate(fetchFn, 'raw template', 'session-1', { warn() {} });
  assert.equal(rendered, 'raw template');
});

test('createThreadRefreshHandler loads sessions and selects the only session', async () => {
  const statuses = [];
  const options = [];
  let selected = '';
  const selectEl = {
    setOptions(next) {
      options.push(next);
    },
    set value(next) {
      selected = next;
    },
  };

  const { fetchFn, FakeEventSource } = createBridgeHarness((request) => {
    assert.equal(request.action, 'list_threads');
    return { threads: [{ id: 'thread-a', cwd: '/repo' }] };
  });
  const prevEventSource = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource;

  const refresh = createThreadRefreshHandler({
    getWsURL: () => 'ws://127.0.0.1:14521',
    fetchFn,
    selectEl,
    getSelectedThreadID: () => selected,
    setSelectedThreadID: (threadID) => { selected = threadID; },
    setStatus: (message) => statuses.push(message),
    log: { warn() {} },
  });

  try {
    await refresh();
    assert.deepEqual(options[0], [{ value: 'thread-a', label: '/repo' }]);
    assert.equal(selected, 'thread-a');
    assert.equal(statuses.at(-1), 'Found 1 Codex session and selected it.');
  } finally {
    globalThis.EventSource = prevEventSource;
  }
});

test('createThreadRefreshHandler ignores concurrent refreshes', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { fetchFn, FakeEventSource } = createBridgeHarness(() => ({ threads: [] }));
  const prevEventSource = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource;

  const refresh = createThreadRefreshHandler({
    getWsURL: () => 'ws://127.0.0.1:14521',
    fetchFn: async (url, options) => {
      calls += 1;
      if (url === '/api/v1/channels/send') await gate;
      return fetchFn(url, options);
    },
    selectEl: { setOptions() {} },
    getSelectedThreadID: () => '',
    setSelectedThreadID() {},
    setStatus() {},
    log: { warn() {} },
  });

  try {
    const first = refresh();
    const second = refresh();
    release();
    await Promise.all([first, second]);
    assert.equal(calls, 2);
  } finally {
    globalThis.EventSource = prevEventSource;
  }
});

test('loadCodexThreads asks the Lua Codex bridge to list sessions', async () => {
  const { fetchFn, FakeEventSource } = createBridgeHarness((request) => {
    assert.equal(request.action, 'list_threads');
    assert.equal(request.wsURL, 'ws://127.0.0.1:14521');
    return { threads: [{ id: 'thread-a', preview: 'Task' }] };
  });
  const prevEventSource = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource;

  try {
    assert.deepEqual(await loadCodexThreads(fetchFn, 'ws://127.0.0.1:14521'), [
      { id: 'thread-a', preview: 'Task' },
    ]);
  } finally {
    globalThis.EventSource = prevEventSource;
  }
});

test('loadCodexModels asks the Lua Codex bridge to list models', async () => {
  const { fetchFn, FakeEventSource } = createBridgeHarness((request) => {
    assert.equal(request.action, 'list_models');
    assert.equal(request.wsURL, 'ws://127.0.0.1:14521');
    return { models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }] };
  });
  const prevEventSource = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource;

  try {
    assert.deepEqual(await loadCodexModels(fetchFn, 'ws://127.0.0.1:14521'), [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
    ]);
  } finally {
    globalThis.EventSource = prevEventSource;
  }
});

test('createModelRefreshHandler loads models and keeps selection', async () => {
  const statuses = [];
  const options = [];
  let selected = 'gpt-5.4';
  const selectEl = {
    setOptions(next) {
      options.push(next);
    },
    set value(next) {
      selected = next;
    },
  };

  const { fetchFn, FakeEventSource } = createBridgeHarness((request) => {
    assert.equal(request.action, 'list_models');
    return {
      models: [
        { id: 'gpt-5.5', label: 'GPT-5.5' },
        { id: 'gpt-5.4', label: 'GPT-5.4' },
      ],
    };
  });
  const prevEventSource = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource;

  const refresh = createModelRefreshHandler({
    getWsURL: () => 'ws://127.0.0.1:14521',
    fetchFn,
    selectEl,
    getSelectedModel: () => selected,
    setSelectedModel: (model) => { selected = model; },
    setStatus: (message) => statuses.push(message),
    log: { warn() {} },
  });

  try {
    await refresh();
    assert.deepEqual(options[0], [
      { value: 'gpt-5.5', label: 'GPT-5.5' },
      { value: 'gpt-5.4', label: 'GPT-5.4' },
    ]);
    assert.equal(selected, 'gpt-5.4');
    assert.equal(statuses.at(-1), 'Found 2 Codex models.');
  } finally {
    globalThis.EventSource = prevEventSource;
  }
});

test('loadCodexThreads surfaces bridge failures', async () => {
  const { fetchFn, FakeEventSource } = createBridgeHarness((_request) => {
    throw new Error('connect to Codex app-server: failed');
  });
  const prevEventSource = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource;

  try {
    await assert.rejects(
      () => requestCodexBridge(fetchFn, { action: 'list_threads' }, {
        requestID: 'fixed',
        timeoutMs: 1000,
      }),
      /connect to Codex app-server/,
    );
  } finally {
    globalThis.EventSource = prevEventSource;
  }
});

test('sendToCodex asks the Lua Codex bridge to deliver content', async () => {
  const { fetchFn, FakeEventSource } = createBridgeHarness((request) => {
    assert.equal(request.action, 'send');
    assert.equal(request.wsURL, 'ws://127.0.0.1:14521');
    assert.equal(request.threadID, 'thread-a');
    assert.equal(request.mode, 'turn');
    assert.equal(request.model, 'gpt-5.5');
    assert.equal(request.content, 'hello');
    return { threadID: 'thread-a', mode: 'turn' };
  });
  const prevEventSource = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource;

  try {
    assert.deepEqual(await sendToCodex(fetchFn, {
      wsURL: 'ws://127.0.0.1:14521',
      threadID: 'thread-a',
      mode: 'turn',
      model: 'gpt-5.5',
      content: 'hello',
    }), { threadID: 'thread-a', mode: 'turn' });
  } finally {
    globalThis.EventSource = prevEventSource;
  }
});

test('handleCodexAutoSend ignores disabled auto-send', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url === '/api/v1/auto-send') {
      return { ok: true, json: async () => ({ enabled: false, destinationIDs: ['dest-codex'] }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  assert.deepEqual(await handleCodexAutoSend({
    fetchFn,
    sessionID: 'session-1',
    log: { error() {} },
  }), { sent: 0, failed: 0, skipped: 0 });
  assert.deepEqual(calls, ['/api/v1/auto-send']);
});

test('handleCodexAutoSend delivers selected Codex destinations', async () => {
  const delivered = [];
  const { fetchFn: bridgeFetch, FakeEventSource } = createBridgeHarness((request) => {
    assert.equal(request.action, 'send');
    delivered.push(request);
    return { threadID: request.threadID, mode: request.mode };
  });
  const prevEventSource = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource;

  const fetchFn = async (url, options = {}) => {
    if (url === '/api/v1/auto-send') {
      return { ok: true, json: async () => ({ enabled: true, destinationIDs: ['dest-codex', 'dest-file'] }) };
    }
    if (url === '/api/v1/destinations') {
      return {
        ok: true,
        json: async () => [
          {
            id: 'dest-codex',
            enabled: true,
            pluginID: 'org.aeor.xenocept.codex.destination',
            pluginConfig: {
              mode: 'inject',
              model: 'gpt-5.4',
              threadID: 'thread-a',
              wsURL: 'ws://127.0.0.1:14521',
              template: 'Session {{ sessionID }}',
            },
          },
          {
            id: 'dest-file',
            enabled: true,
            pluginID: 'org.aeor.xenocept.file',
            pluginConfig: {},
          },
        ],
      };
    }
    if (url === '/api/v1/template/render') {
      assert.equal(JSON.parse(options.body).session_id, 'session-1');
      return { ok: true, json: async () => ({ rendered: 'rendered session' }) };
    }
    return bridgeFetch(url, options);
  };

  try {
    assert.deepEqual(await handleCodexAutoSend({
      fetchFn,
      sessionID: 'session-1',
      log: { error() {} },
    }), { sent: 1, failed: 0, skipped: 0 });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].threadID, 'thread-a');
    assert.equal(delivered[0].mode, 'inject');
    assert.equal(delivered[0].model, 'gpt-5.4');
    assert.equal(delivered[0].content, 'rendered session');
  } finally {
    globalThis.EventSource = prevEventSource;
  }
});

test('handleCodexAutoSend skips duplicate session destination deliveries', async () => {
  const deliveredKeys = new Set();
  let sends = 0;
  const { fetchFn: bridgeFetch, FakeEventSource } = createBridgeHarness((request) => {
    assert.equal(request.action, 'send');
    sends += 1;
    return { threadID: request.threadID, mode: request.mode };
  });
  const prevEventSource = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource;

  const fetchFn = async (url, options = {}) => {
    if (url === '/api/v1/auto-send') {
      return { ok: true, json: async () => ({ enabled: true, destinationIDs: ['dest-codex'] }) };
    }
    if (url === '/api/v1/destinations') {
      return {
        ok: true,
        json: async () => [{
          id: 'dest-codex',
          enabled: true,
          pluginID: 'org.aeor.xenocept.codex.destination',
          pluginConfig: { threadID: 'thread-a' },
        }],
      };
    }
    if (url === '/api/v1/template/render') {
      return { ok: true, json: async () => ({ rendered: 'rendered session' }) };
    }
    return bridgeFetch(url, options);
  };

  try {
    assert.deepEqual(await handleCodexAutoSend({
      fetchFn,
      sessionID: 'session-1',
      deliveredKeys,
      log: { error() {} },
    }), { sent: 1, failed: 0, skipped: 0 });
    assert.deepEqual(await handleCodexAutoSend({
      fetchFn,
      sessionID: 'session-1',
      deliveredKeys,
      log: { error() {} },
    }), { sent: 0, failed: 0, skipped: 1 });
    assert.equal(sends, 1);
  } finally {
    globalThis.EventSource = prevEventSource;
  }
});

test('resolveThreadID uses explicit configured thread', async () => {
  const id = await resolveThreadID({ loadedThreadIDs: async () => { throw new Error('should not load'); } }, ' explicit ');
  assert.equal(id, 'explicit');
});

test('resolveThreadID uses the only available thread', async () => {
  const id = await resolveThreadID({ availableThreads: async () => [{ id: 'thread-a' }] }, '');
  assert.equal(id, 'thread-a');
});

test('resolveThreadID rejects zero or multiple available threads', async () => {
  await assert.rejects(
    () => resolveThreadID({ availableThreads: async () => [] }, ''),
    /No Codex sessions/,
  );
  await assert.rejects(
    () => resolveThreadID({ availableThreads: async () => [{ id: 'a' }, { id: 'b' }] }, ''),
    /Multiple Codex sessions/,
  );
});

test('CodexAppServerClient initializes and starts a turn', async () => {
  FakeWebSocket.instances.length = 0;
  const client = new CodexAppServerClient({
    wsURL: 'ws://127.0.0.1:14521',
    WebSocketImpl: FakeWebSocket,
    timeoutMs: 1000,
  });
  await client.connect();
  const loaded = await client.loadedThreadIDs();
  assert.deepEqual(loaded, ['thread-1']);
  const threads = await client.availableThreads();
  assert.deepEqual(threads, [{ id: 'thread-1', title: '', name: '', preview: 'Main task', cwd: '/repo', status: 'notLoaded' }]);
  await client.resumeThread('thread-1');
  await client.startTurn('thread-1', 'hello');
  const sentMethods = FakeWebSocket.instances[0].sent.map((msg) => msg.method);
  assert.deepEqual(sentMethods, ['initialize', 'initialized', 'thread/loaded/list', 'thread/list', 'thread/resume', 'turn/start']);
  client.close();
});

test('CodexAppServerClient passes auth token as subprotocols', async () => {
  FakeWebSocket.instances.length = 0;
  const client = new CodexAppServerClient({
    wsURL: 'ws://127.0.0.1:14521',
    authToken: 'secret-token',
    WebSocketImpl: FakeWebSocket,
    timeoutMs: 1000,
  });
  await client.connect();
  assert.deepEqual(FakeWebSocket.instances[0].protocols, ['bearer', 'secret-token']);
  client.close();
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}
