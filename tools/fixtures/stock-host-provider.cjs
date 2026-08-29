"use strict";
function createProtoSessionProvider(client, requestedModel, modelConfig, inferenceReason) {
  return {
    kind: "proto",
    model: (requestedModel && requestedModel.modelId) || "none",
    inferenceReason: inferenceReason,
  };
}
function ping() {
  const client = { kind: "cursor-backend" };
  const options2 = { requestedModel: { modelId: "stock-model" }, inferenceReason: "chat" };
  return createProtoSessionProvider(
    client,
    options2.requestedModel,
    void 0,
    options2.inferenceReason
  );
}
module.exports = { ping, createProtoSessionProvider };
