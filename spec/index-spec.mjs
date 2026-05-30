import assert from 'node:assert/strict';
import {
  CodexAppServerClient,
  buildThreadOptions,
  buildInjectedUserItems,
  buildTurnInput,
  explainConnectionFailure,
  formatThreadLabel,
  loadCodexThreads,
  populateThreadSelect,
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

test('loadCodexThreads calls the Xenocept Codex bridge', async () => {
  const fetchFn = async (url, options) => {
    assert.equal(url, '/api/v1/codex/app-server/threads');
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).wsURL, 'ws://127.0.0.1:14521');
    return {
      ok: true,
      json: async () => ({ threads: [{ id: 'thread-a', preview: 'Task' }] }),
    };
  };

  assert.deepEqual(await loadCodexThreads(fetchFn, 'ws://127.0.0.1:14521'), [
    { id: 'thread-a', preview: 'Task' },
  ]);
});

test('loadCodexThreads surfaces bridge failures', async () => {
  const fetchFn = async () => ({
    ok: false,
    status: 502,
    text: async () => 'connect to Codex app-server: failed',
  });

  await assert.rejects(
    () => loadCodexThreads(fetchFn, 'ws://127.0.0.1:14521'),
    /connect to Codex app-server/,
  );
});

test('sendToCodex posts content to the Xenocept Codex bridge', async () => {
  const fetchFn = async (url, options) => {
    assert.equal(url, '/api/v1/codex/app-server/send');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), {
      wsURL: 'ws://127.0.0.1:14521',
      threadID: 'thread-a',
      mode: 'turn',
      content: 'hello',
    });
    return {
      ok: true,
      json: async () => ({ threadID: 'thread-a', mode: 'turn' }),
    };
  };

  assert.deepEqual(await sendToCodex(fetchFn, {
    wsURL: 'ws://127.0.0.1:14521',
    threadID: 'thread-a',
    mode: 'turn',
    content: 'hello',
  }), { threadID: 'thread-a', mode: 'turn' });
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
