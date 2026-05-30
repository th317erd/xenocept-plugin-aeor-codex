import assert from 'node:assert/strict';
import {
  CodexAppServerClient,
  buildInjectedUserItems,
  buildTurnInput,
  formatThreadLabel,
  renderSessionTemplate,
  replaceThreadPickerOptions,
  resolveThreadID,
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

test('formatThreadLabel prefers useful metadata', () => {
  assert.equal(
    formatThreadLabel({ id: 'thread-1234567890abcdef', title: 'Main task', cwd: '/repo' }),
    'Main task - /repo (thread-1...abcdef)',
  );
  assert.equal(formatThreadLabel({ id: 'thread-1', cwd: '/repo' }), '/repo (thread-1)');
  assert.equal(formatThreadLabel({ id: 'thread-1' }), 'thread-1');
});

test('replaceThreadPickerOptions renders empty and loaded states', () => {
  const options = [];
  const fakeDoc = {
    createElement() {
      const opt = { value: '', textContent: '' };
      options.push(opt);
      return opt;
    },
  };
  const selectEl = {
    firstChild: null,
    children: [],
    appendChild(opt) {
      this.children.push(opt);
      this.firstChild = this.children[0] || null;
    },
    removeChild() {
      this.children.shift();
      this.firstChild = this.children[0] || null;
    },
  };

  replaceThreadPickerOptions(selectEl, [], fakeDoc);
  assert.equal(selectEl.children[0].textContent, 'No loaded Codex sessions');

  selectEl.children = [];
  selectEl.firstChild = null;
  replaceThreadPickerOptions(selectEl, [{ id: 'thread-1', title: 'Main' }], fakeDoc);
  assert.equal(selectEl.children[0].value, 'thread-1');
  assert.equal(selectEl.children[0].textContent, 'Main (thread-1)');
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

test('resolveThreadID uses explicit configured thread', async () => {
  const id = await resolveThreadID({ loadedThreadIDs: async () => { throw new Error('should not load'); } }, ' explicit ');
  assert.equal(id, 'explicit');
});

test('resolveThreadID uses the only loaded thread', async () => {
  const id = await resolveThreadID({ loadedThreadIDs: async () => ['thread-a'] }, '');
  assert.equal(id, 'thread-a');
});

test('resolveThreadID rejects zero or multiple loaded threads', async () => {
  await assert.rejects(
    () => resolveThreadID({ loadedThreadIDs: async () => [] }, ''),
    /No loaded Codex threads/,
  );
  await assert.rejects(
    () => resolveThreadID({ loadedThreadIDs: async () => ['a', 'b'] }, ''),
    /Multiple loaded Codex threads/,
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
  const threads = await client.loadedThreads();
  assert.deepEqual(threads, [{ id: 'thread-1', title: 'Main task', name: '', cwd: '/repo', status: '' }]);
  await client.startTurn('thread-1', 'hello');
  const sentMethods = FakeWebSocket.instances[0].sent.map((msg) => msg.method);
  assert.deepEqual(sentMethods, ['initialize', 'initialized', 'thread/loaded/list', 'thread/loaded/list', 'thread/read', 'turn/start']);
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
