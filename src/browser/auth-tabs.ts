const callbacks = new Set([
  "https://tmedit.org/auth/verify/callback",
  "https://atnd.tmedit.org/auth/verify/callback",
  "https://cs.tmedit.org/auth/verify/callback",
]);

function validRedirect(value: unknown): value is string {
  if (value === "/verified") return true;
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash &&
      callbacks.has(`${url.origin}${url.pathname}`) &&
      !!url.searchParams.get("code") && !!url.searchParams.get("state");
  } catch {
    return false;
  }
}

function openChannel(flow: string): BroadcastChannel | null {
  try {
    return new BroadcastChannel(`verify-flow:${flow}`);
  } catch {
    return null;
  }
}

type Message = { type?: unknown; receiver?: unknown; redirect?: unknown };

function message(value: unknown): Message {
  return typeof value === "object" && value !== null ? value : {};
}

export function listenForAuthCompletion(flow: string, complete: (redirect: string) => void): () => void {
  const channel = openChannel(flow);
  if (!channel) return () => {};
  const receiver = crypto.randomUUID();
  let pendingRedirect: string | undefined;
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const data = message(event.data);
    if (data.type === "request") channel.postMessage({ type: "ready", receiver });
    if (data.type === "complete" && data.receiver === receiver && validRedirect(data.redirect)) {
      pendingRedirect = data.redirect;
      channel.postMessage({ type: "received", receiver });
    } else if (data.type === "navigate" && data.receiver === receiver && pendingRedirect) {
      channel.close();
      complete(pendingRedirect);
    }
  };
  return () => channel.close();
}

export function handoffAuthCompletion(flow: string, redirect: string, timeoutMs = 1500): Promise<boolean> {
  if (!validRedirect(redirect)) return Promise.resolve(false);
  const channel = openChannel(flow);
  if (!channel) return Promise.resolve(false);
  return new Promise((resolve) => {
    let receiver: string | undefined;
    const finish = (received: boolean) => {
      clearTimeout(timer);
      channel.close();
      resolve(received);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const data = message(event.data);
      if (data.type === "ready" && typeof data.receiver === "string" && !receiver) {
        receiver = data.receiver;
        channel.postMessage({ type: "complete", receiver, redirect });
      } else if (data.type === "received" && receiver && data.receiver === receiver) {
        channel.postMessage({ type: "navigate", receiver });
        finish(true);
      }
    };
    channel.postMessage({ type: "request" });
  });
}
