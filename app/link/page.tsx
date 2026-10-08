"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/shell";
import { HomeButton } from "@/components/home-button";
import { handoffAuthCompletion } from "@/src/browser/auth-tabs";

type View = "checking" | "ready" | "other" | "invalid" | "error" | "complete";
type LinkStatus = "ready" | "other_browser" | "invalid";

export default function LinkPage() {
  const [flow, setFlow] = useState("");
  const [token, setToken] = useState("");
  const [view, setView] = useState<View>("checking");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function checkLink(id: string, value: string) {
    try {
      const response = await fetch("/auth/link/status", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flow: id, token: value }),
      });
      if (!response.ok) throw new Error("status failed");
      const result = await response.json() as { status?: LinkStatus };
      if (result.status === "ready") setView("ready");
      else if (result.status === "other_browser") setView("other");
      else if (result.status === "invalid") setView("invalid");
      else throw new Error("invalid status");
    } catch {
      setView("error");
    }
  }

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("flow");
    const value = new URLSearchParams(window.location.hash.slice(1)).get("token");
    if (!id || !value) {
      setView("invalid");
      return;
    }
    setFlow(id);
    setToken(value);
    void checkLink(id, value);
  }, []);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setMessage("URLをコピーしました。");
    } catch {
      setMessage("コピーできませんでした。アドレスバーから完全な URL をコピーしてください。");
    }
  }

  function closeTab() {
    try {
      window.close();
    } catch {
      setMessage("自動で閉じられませんでした。このタブを閉じ、元のタブに戻ってください。");
    }
  }

  async function confirm() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/auth/confirm", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flow, token }),
      });
      const result = await response.json() as { redirect?: string };
      if (response.ok && result.redirect) {
        window.history.replaceState(null, "", `/link?flow=${encodeURIComponent(flow)}`);
        setToken("");
        if (await handoffAuthCompletion(flow, result.redirect)) {
          setView("complete");
          closeTab();
        } else {
          window.location.assign(result.redirect);
        }
      } else if (response.status === 409) {
        await checkLink(flow, token);
      } else if (response.status >= 500 || response.ok) {
        setView("error");
      } else {
        setView("invalid");
      }
    } catch {
      setMessage("確認できませんでした。再度お試しください。");
      setView("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title="確認リンク">
      {view === "checking" && <p role="status">リンクとブラウザを確認しています…</p>}
      {view === "ready" && (
        <div>
          <div className="notice"><span className="notice-icon" aria-hidden="true">✓</span><div><strong>メールを受け取れました</strong><p>認証を始めたブラウザで、下のボタンを押すと確認が完了します。</p></div></div>
          <button type="button" disabled={busy} onClick={confirm}>確認を完了する</button>
        </div>
      )}
      {view === "other" && (
        <div>
          <div className="notice warning"><span className="notice-icon" aria-hidden="true">↗</span><div><strong>元のブラウザで開いてください</strong><p>このリンクは別のブラウザで開かれています。完全な URL をコピーし、認証を始めたブラウザで開いてください。</p></div></div>
          <button type="button" onClick={copyLink}>完全な URL をコピー</button>
        </div>
      )}
      {view === "invalid" && (
        <div className="notice warning"><span className="notice-icon" aria-hidden="true">!</span><div><strong>このリンクは使えません</strong><p>リンクが正しくないか、期限切れか、すでに使用されています。連携先から認証をやり直してください。</p></div></div>
      )}
      {view === "error" && (
        <div>
          <div className="notice warning"><span className="notice-icon" aria-hidden="true">!</span><div><strong>リンクを確認できませんでした</strong><p>通信状態を確認して、もう一度お試しください。</p></div></div>
          <button type="button" onClick={() => window.location.reload()}>再試行</button>
        </div>
      )}
      {view === "complete" && (
        <div>
          <div className="notice"><span className="notice-icon" aria-hidden="true">✓</span><div><strong>確認が完了しました</strong><p>元のタブで認証を続けています。このタブは閉じてください。</p></div></div>
          <button type="button" onClick={closeTab}>このタブを閉じる</button>
        </div>
      )}
      <p className="message" role="alert">{message}</p>
      {(view === "checking" || view === "invalid") && <HomeButton />}
    </Shell>
  );
}
