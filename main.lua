-- xenocept-plugin-aeor-codex subprocess bridge.
--
-- Invocation:
--   xenocept plugin://org.aeor.xenocept.codex/bridge?channel=xenocept-codex-control
--
-- The browser-side destination UI sends request messages to the named
-- Xenocept channel. This Lua subprocess owns all Codex app-server
-- JSON-RPC behavior and replies on a per-request response channel.

local DEFAULT_WS_URL = "ws://127.0.0.1:14521"
local CONTROL_CHANNEL = "xenocept-codex-control"

local channel_unsub = nil

local function url_encode(s)
  return (s:gsub("[^%w%-_.~]", function(c)
    return string.format("%%%02X", string.byte(c))
  end))
end

local function text_or_empty(v)
  if v == nil then return "" end
  return tostring(v)
end

local function rpc_result(msg, method)
  if msg.error ~= nil then
    local err = msg.error
    if type(err) == "table" and err.message then
      error("Codex app-server " .. method .. " failed: " .. tostring(err.message))
    end
    error("Codex app-server " .. method .. " failed: " .. json.stringify(err))
  end
  return msg.result or {}
end

local function connect_codex(ws_url)
  local client = xnc.jsonrpc_ws_connect(ws_url or DEFAULT_WS_URL)
  rpc_result(client:request("initialize", {
    clientInfo = {
      name = "xenocept-plugin-aeor-codex",
      title = "Xenocept Codex Destination",
      version = "0.1.0",
    },
    capabilities = {
      experimentalApi = true,
    },
  }), "initialize")
  client:notify("initialized", {})
  return client
end

local function normalize_thread(thread)
  return {
    id = text_or_empty(thread.id),
    title = text_or_empty(thread.title),
    name = text_or_empty(thread.name),
    preview = text_or_empty(thread.preview),
    cwd = text_or_empty(thread.cwd),
    status = type(thread.status) == "table" and text_or_empty(thread.status.type) or "",
  }
end

local function list_threads(request)
  local client = connect_codex(request.wsURL or DEFAULT_WS_URL)
  local result = rpc_result(client:request("thread/list", { limit = 50 }), "thread/list")
  local threads = {}
  if type(result.data) == "table" then
    for _, thread in ipairs(result.data) do
      if type(thread) == "table" and thread.id ~= nil and tostring(thread.id) ~= "" then
        table.insert(threads, normalize_thread(thread))
      end
    end
  end
  return { threads = threads }
end

local function resolve_thread_id(client, configured_thread_id)
  local explicit = text_or_empty(configured_thread_id):match("^%s*(.-)%s*$")
  if explicit ~= "" then return explicit end

  local result = rpc_result(client:request("thread/list", { limit = 50 }), "thread/list")
  local ids = {}
  if type(result.data) == "table" then
    for _, thread in ipairs(result.data) do
      if type(thread) == "table" and thread.id ~= nil and tostring(thread.id) ~= "" then
        table.insert(ids, tostring(thread.id))
      end
    end
  end
  if #ids == 1 then return ids[1] end
  if #ids == 0 then
    error("No Codex sessions found. Start Codex app-server and open at least one Codex session.")
  end
  error("Multiple Codex sessions found (" .. tostring(#ids) .. "). Select a Codex session.")
end

local function resume_thread(client, thread_id)
  local ok, err = pcall(function()
    rpc_result(client:request("thread/resume", {
      threadId = thread_id,
      includeTurns = false,
    }), "thread/resume")
  end)
  if ok then return end
  local message = tostring(err)
  if not message:lower():find("already loaded", 1, true)
     and not message:lower():find("active", 1, true)
     and not message:lower():find("loaded", 1, true) then
    error(message)
  end
end

local function send_to_codex(request)
  local client = connect_codex(request.wsURL or DEFAULT_WS_URL)
  local thread_id = resolve_thread_id(client, request.threadID)
  resume_thread(client, thread_id)

  local content = text_or_empty(request.content)
  local mode = request.mode == "inject" and "inject" or "turn"
  if mode == "inject" then
    rpc_result(client:request("thread/inject_items", {
      threadId = thread_id,
      items = {
        {
          type = "message",
          role = "user",
          content = {
            { type = "input_text", text = content },
          },
        },
      },
    }), "thread/inject_items")
  else
    rpc_result(client:request("turn/start", {
      threadId = thread_id,
      input = {
        { type = "text", text = content },
      },
    }), "turn/start")
  end

  return { threadID = thread_id, mode = mode }
end

local function reply(request, ok, value)
  if request.replyChannel == nil or request.replyChannel == "" then
    return
  end
  local body
  if ok then
    body = { id = request.id, ok = true, result = value or {} }
  else
    body = { id = request.id, ok = false, error = tostring(value) }
  end
  local resp = xnc.xenoceptFetch("/api/v1/channels/send", {
    method = "POST",
    headers = { ["content-type"] = "application/json" },
    body = json.stringify({
      names = { request.replyChannel },
      content = json.stringify(body),
      meta = { pluginID = xnc.plugin_id },
    }),
  })
  if not resp.ok then
    error("reply channel send HTTP " .. tostring(resp.status) .. ": " .. tostring(resp.body))
  end
end

local function handle_request(event)
  local content = type(event) == "table" and event.content or nil
  if type(content) ~= "string" then return end
  local parse_ok, request = pcall(json.parse, content)
  if not parse_ok or type(request) ~= "table" then return end

  local ok, result = pcall(function()
    if request.action == "list_threads" then
      return list_threads(request)
    elseif request.action == "send" then
      return send_to_codex(request)
    else
      error("unknown Codex bridge action: " .. tostring(request.action))
    end
  end)
  reply(request, ok, result)
end

xnc.register({
  on_startup = function()
    local channel = xnc.params.channel or CONTROL_CHANNEL
    xnc.log("codex bridge starting (channel=" .. tostring(channel) .. ")")
    channel_unsub = xnc.channel.subscribe(channel, handle_request)
  end,

  on_shutdown = function(reason)
    xnc.log("codex bridge shutting down: " .. tostring(reason))
    if channel_unsub then
      pcall(channel_unsub)
      channel_unsub = nil
    end
  end,

  on_error = function(err, source)
    xnc.log_error("[" .. tostring(source) .. "] " .. tostring(err))
  end,
})
