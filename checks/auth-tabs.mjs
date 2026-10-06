import assert from "node:assert/strict";
import test from "node:test";
import { handoffAuthCompletion, listenForAuthCompletion } from "../src/browser/auth-tabs.ts";

const redirect = "https://atnd.tmedit.org/auth/verify/callback?code=test-code&state=test-state";

test("同じフローの元タブへ戻り先を渡し、受領確認を待つ", async () => {
  const received = [];
  const completion = Promise.withResolvers();
  const stop = listenForAuthCompletion("same-flow", (value) => {
    received.push(value);
    completion.resolve();
  });
  try {
    assert.equal(await handoffAuthCompletion("same-flow", redirect), true);
    await completion.promise;
    assert.deepEqual(received, [redirect]);
  } finally {
    stop();
  }
});

test("同じフローのタブが複数あっても、一つだけがコードを受け取る", async () => {
  const received = [];
  const completion = Promise.withResolvers();
  const complete = (value) => {
    received.push(value);
    completion.resolve();
  };
  const stops = [
    listenForAuthCompletion("duplicated-flow", complete),
    listenForAuthCompletion("duplicated-flow", complete),
  ];
  try {
    assert.equal(await handoffAuthCompletion("duplicated-flow", "/verified"), true);
    await completion.promise;
    assert.deepEqual(received, ["/verified"]);
  } finally {
    stops.forEach((stop) => stop());
  }
});

test("受領通知が届かない場合は元タブへ遷移を指示しない", async () => {
  const channel = new BroadcastChannel("verify-flow:unresponsive-flow");
  const received = [];
  channel.onmessage = ({ data }) => {
    received.push(data.type);
    if (data.type === "request") channel.postMessage({ type: "ready", receiver: "unresponsive-tab" });
  };
  try {
    assert.equal(await handoffAuthCompletion("unresponsive-flow", redirect, 50), false);
    assert.deepEqual(received, ["request", "complete"]);
  } finally {
    channel.close();
  }
});

test("元タブがない場合や別フローの場合はリンク側で続行できる", async () => {
  const received = [];
  const stop = listenForAuthCompletion("another-flow", (value) => received.push(value));
  try {
    assert.equal(await handoffAuthCompletion("missing-flow", redirect, 50), false);
    assert.deepEqual(received, []);
  } finally {
    stop();
  }
});

test("許可されていない戻り先を元タブへ渡さない", async () => {
  const received = [];
  const stop = listenForAuthCompletion("invalid-redirect", (value) => received.push(value));
  try {
    assert.equal(await handoffAuthCompletion("invalid-redirect", "https://example.org/auth/verify/callback?code=x&state=y"), false);
    assert.equal(await handoffAuthCompletion("invalid-redirect", "javascript:alert(1)"), false);
    assert.deepEqual(received, []);
  } finally {
    stop();
  }
});
