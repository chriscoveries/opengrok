"use strict";
var fs = require("fs");
var path = require("path");
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

function wrapSession(stockFn, args) {
  var arr = Array.prototype.slice.call(args);
  if (process.env.OPENGROK_PROBE_PROTO === "1") {
    var stock = stockFn.apply(null, arr);
    try {
      var keys = stock && typeof stock === "object" ? Object.getOwnPropertyNames(stock) : [];
      fs.writeFileSync("/tmp/opengrok-proto-keys.json", JSON.stringify({
        type: typeof stock,
        keys: keys,
      }, null, 2));
    } catch (e) {
      log("probe write failed: " + e.message);
    }
    return stock;
  }
  var binding = resolveBinding(arr);
  if (!binding || !binding.hopBaseUrl || !binding.modelId) {
    var err = new Error("opengrok: no model binding for this turn (set agents['*'] or a matching agent id in model-bindings.json)");
    log(err.message);
    throw err;
  }
  log("route " + binding.modelId + " -> " + binding.hopBaseUrl);
  return hop.createOpenAiHopSession({
    modelId: binding.modelId,
    baseUrl: binding.hopBaseUrl,
    maxMode: binding.maxMode === true,
    parameters: Array.isArray(binding.parameters) ? binding.parameters : [],
    requestKind: "main",
  });
}

module.exports = {
  wrapSession: wrapSession,
  resolveBinding: resolveBinding,
  collectIds: collectIds,
  completionsUrl: hop.completionsUrl,
};
