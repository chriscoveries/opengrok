"use strict";
var fs = require("fs");
var hop = require("./openai-hop-session.cjs");

var BINDINGS = process.env.OPENGROK_BINDINGS || "/home/box/sand-data/model-bindings.json";
var LOG = process.env.OPENGROK_LOG || "/tmp/opengrok-session.log";

function log(line) {
  try {
    fs.appendFileSync(LOG, new Date().toISOString() + " " + line + "\n");
  } catch (e) {
    /* ignore */
  }
}

function collectIds(args) {
  var ids = [];
  var seen = Object.create(null);
  function add(s) {
    if (typeof s !== "string") return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return;
    var k = s.toLowerCase();
    if (seen[k]) return;
    seen[k] = true;
    ids.push(s);
  }
  function walk(v, depth) {
    if (depth > 5 || v == null) return;
    if (typeof v === "string") { add(v); return; }
    if (typeof v !== "object") return;
    var keys = ["conversationId", "agentId", "id", "provenanceAgentId", "botId"];
    for (var i = 0; i < keys.length; i++) {
      if (v[keys[i]] != null) walk(v[keys[i]], depth + 1);
    }
  }
  for (var i = 0; i < args.length; i++) walk(args[i], 0);
  return ids;
}

function loadAgents() {
  var raw = fs.readFileSync(BINDINGS, "utf8");
  var data = JSON.parse(raw);
  return (data && data.agents) || {};
}

function resolveBinding(args) {
  var agents;
  try {
    agents = loadAgents();
  } catch (e) {
    log("bindings unreadable: " + e.message);
    return null;
  }
  var ids = collectIds(args);
  for (var i = 0; i < ids.length; i++) {
    if (agents[ids[i]]) return agents[ids[i]];
  }
  if (agents["*"]) return agents["*"];
  return null;
}

function requestedModelId(args) {
  var req = args && args[1];
  if (req && typeof req.modelId === "string") return req.modelId;
  if (req && req.modelId && typeof req.modelId.modelId === "string") return req.modelId.modelId;
  return "";
}

function dumpProto(stock) {
  var proto = stock && typeof stock === "object" ? Object.getPrototypeOf(stock) : null;
  var own = stock && typeof stock === "object" ? Object.getOwnPropertyNames(stock) : [];
  var protoKeys = proto && proto !== Object.prototype ? Object.getOwnPropertyNames(proto) : [];
  fs.writeFileSync("/tmp/opengrok-proto-keys.json", JSON.stringify({
    type: typeof stock,
    ctor: stock && stock.constructor && stock.constructor.name,
    own: own,
    proto: protoKeys,
  }, null, 2));
}

function swallow(p) {
  Promise.resolve(p).catch(function () {});
  return p;
}

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  var bits = [];
  for (var i = 0; i < content.length; i++) {
    var p = content[i];
    if (p == null) continue;
    if (typeof p === "string") bits.push(p);
    else if (p.type === "text") bits.push(p.text || "");
    else if (p.type === "image") bits.push("[image]");
    else if (p.type === "tool-result") bits.push(typeof p.result === "string" ? p.result : JSON.stringify(p.result || p));
    else bits.push(JSON.stringify(p));
  }
  return bits.join("\n");
}

function toOpenAIMessages(msgs) {
  if (!Array.isArray(msgs)) return [{ role: "user", content: String(msgs || "") }];
  var out = [];
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i] || {};
    var role = m.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") role = "user";
    var row = { role: role, content: contentToText(m.content) };
    if (role === "tool" && m.toolCallId) row.tool_call_id = m.toolCallId;
    if (role === "assistant" && Array.isArray(m.tool_calls)) row.tool_calls = m.tool_calls;
    out.push(row);
  }
  return out.length ? out : [{ role: "user", content: "" }];
}

function toOpenAITools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  var out = [];
  for (var i = 0; i < tools.length; i++) {
    var t = tools[i];
    if (!t || t.type === "provider-defined") continue;
    var fn = t.function || t;
    var name = t.name || fn.name;
    if (!name) continue;
    out.push({
      type: "function",
      function: {
        name: name,
        description: t.description || fn.description || "",
        parameters: t.parameters || fn.parameters || { type: "object", properties: {} },
      },
    });
  }
  return out.length ? out : undefined;
}

function hopFullStream(exec, hopSess, ctx, invocationId, tools, options2) {
  var settled = { u: false, e: false, m: false, i: false, r: false };
  var resU, rejU, resE, rejE, resM, rejM, resI, rejI, resR, rejR;
  var usage = swallow(new Promise(function (res, rej) { resU = res; rejU = rej; }));
  var extendedUsage = swallow(new Promise(function (res, rej) { resE = res; rejE = rej; }));
  var providerMetadata = swallow(new Promise(function (res, rej) { resM = res; rejM = rej; }));
  var inv = swallow(new Promise(function (res, rej) { resI = res; rejI = rej; }));
  var response = swallow(new Promise(function (res, rej) { resR = res; rejR = rej; }));

  function failAll(err) {
    if (!settled.u) { settled.u = true; rejU(err); }
    if (!settled.e) { settled.e = true; rejE(err); }
    if (!settled.m) { settled.m = true; rejM(err); }
    if (!settled.i) { settled.i = true; rejI(err); }
    if (!settled.r) { settled.r = true; rejR(err); }
  }
  function okUsage(u) {
    if (!settled.u) { settled.u = true; resU(u); }
    if (!settled.e) {
      settled.e = true;
      resE({
        inputTokens: u.promptTokens || 0,
        outputTokens: u.completionTokens || 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        maxTokens: 0,
      });
    }
    if (!settled.m) { settled.m = true; resM(undefined); }
    if (!settled.i) { settled.i = true; resI(invocationId || (crypto.randomUUID && crypto.randomUUID()) || "opengrok"); }
  }

  if (ctx && ctx.signal) {
    if (ctx.signal.aborted) hopSess.abort();
    else ctx.signal.addEventListener("abort", function () { hopSess.abort(); });
  }

  var fullStream = (async function* () {
    try {
      var msgs = typeof exec.getMessages === "function" ? exec.getMessages() : [];
      var turn = {
        messages: toOpenAIMessages(msgs),
        tools: toOpenAITools(tools),
      };
      if (options2 && options2.maxTokens != null) turn.max_tokens = options2.maxTokens;
      log("stream messages=" + turn.messages.length);
      var out = await hopSess.runTurn(turn);
      var text = (out && out.content) || "";
      if (out && out.reasoning_content) {
        yield { type: "reasoning", textDelta: out.reasoning_content };
      }
      if (text) yield { type: "text-delta", textDelta: text };
      var u = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      var ru = out && out.raw && out.raw.usage;
      if (ru) {
        u.promptTokens = ru.prompt_tokens || 0;
        u.completionTokens = ru.completion_tokens || 0;
        u.totalTokens = ru.total_tokens || 0;
      }
      yield { type: "finish", finishReason: (out && out.finish_reason) || "stop", usage: u };
      okUsage(u);
      if (!settled.r) {
        settled.r = true;
        resR({
          id: (out && out.raw && out.raw.id) || "",
          modelId: hopSess.modelId,
          timestamp: new Date(),
          messages: [{ role: "assistant", content: text }],
        });
      }
    } catch (err) {
      log("stream error " + (err && err.message));
      failAll(err);
      yield { type: "error", error: err };
      throw err;
    }
  })();

  return {
    fullStream: fullStream,
    usage: usage,
    extendedUsage: extendedUsage,
    providerMetadata: providerMetadata,
    invocationId: inv,
    response: response,
  };
}

function wrapExecutor(exec, hopSess) {
  return new Proxy(exec, {
    get: function (target, prop, receiver) {
      if (prop === "stream") {
        return function (ctx, invocationId, tools, options2) {
          return hopFullStream(target, hopSess, ctx, invocationId, tools, options2);
        };
      }
      var val = Reflect.get(target, prop, receiver);
      if (typeof val === "function") return val.bind(target);
      return val;
    },
  });
}

function wrapPromptSession(inner, hopSess, binding, middleware) {
  return {
    getExecutor: function (state) {
      var raw = inner.getExecutor(state);
      var hopExec = wrapExecutor(raw, hopSess);
      return middleware ? middleware(hopExec) : hopExec;
    },
    getModelId: function () {
      return binding.modelId;
    },
  };
}

function wrapProvider(stockProvider, hopSess, binding) {
  return {
    opengrok: true,
    modelId: binding.modelId,
    getSession: function (middleware) {
      var inner = stockProvider.getSession(undefined);
      return wrapPromptSession(inner, hopSess, binding, middleware);
    },
    getProviderName: function () {
      return typeof stockProvider.getProviderName === "function" ? stockProvider.getProviderName() : "proto";
    },
    getModelId: function () {
      return binding.modelId;
    },
    getThinkingDetails: function () {
      return typeof stockProvider.getThinkingDetails === "function" ? stockProvider.getThinkingDetails() : undefined;
    },
  };
}

function wrapBareHop(hopSess) {
  hopSess.getSession = function () { return hopSess; };
  hopSess.getProviderName = function () { return "proto"; };
  hopSess.getModelId = function () { return hopSess.modelId; };
  hopSess.getThinkingDetails = function () { return undefined; };
  return hopSess;
}

function wrapSession(stockFn, args) {
  var arr = Array.prototype.slice.call(args);
  if (process.env.OPENGROK_PROBE_PROTO === "1") {
    var probed = stockFn.apply(null, arr);
    try { dumpProto(probed); } catch (e) { log("probe write failed: " + e.message); }
    return probed;
  }
  var binding = resolveBinding(arr);
  if (!binding || !binding.hopBaseUrl || !binding.modelId) {
    var err = new Error("opengrok: no model binding for this turn (set agents['*'] or a matching agent id in model-bindings.json)");
    log(err.message);
    throw err;
  }
  var requested = requestedModelId(arr);
  log("route " + binding.modelId + " -> " + binding.hopBaseUrl + (requested ? " requested=" + requested : ""));
  var hopSess = hop.createOpenAiHopSession({
    modelId: binding.modelId,
    baseUrl: binding.hopBaseUrl,
    maxMode: binding.maxMode === true,
    parameters: Array.isArray(binding.parameters) ? binding.parameters : [],
    requestKind: "main",
  });
  var stock = stockFn.apply(null, arr);
  if (stock && typeof stock.getSession === "function") {
    return wrapProvider(stock, hopSess, binding);
  }
  return wrapBareHop(hopSess);
}

module.exports = {
  wrapSession: wrapSession,
  resolveBinding: resolveBinding,
  collectIds: collectIds,
  completionsUrl: hop.completionsUrl,
};
