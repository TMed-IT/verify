"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Shell } from "@/components/shell";
import { HomeButton } from "@/components/home-button";
import { listenForAuthCompletion } from "@/src/browser/auth-tabs";

type View = "checking" | "form" | "existing" | "sent" | "invalid" | "error";

export default function StartPage() {
  const [flow, setFlow] = useState("");
  const [view, setView] = useState<View>("checking");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function checkFlow(id: string) {
    setView("checking");
    setMessage("");
    try {
      const response = await fetch(`/auth/flow?flow=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("flow check failed");
      const result = await response.json() as { valid: boolean; authenticated?: boolean };
      if (!result.valid) {
        setMessage("認証の有効期限が切れました。最初からやり直してください。");
        setView("invalid");
      } else {
        setView(result.authenticated ? "existing" : "form");
      }
    } catch {
      setMessage("認証を確認できませんでした。再度お試しください。");
      setView("error");
    }
  }

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("flow");
    if (!id) {
      setMessage("認証の開始情報がありません。最初からやり直してください。");
      setView("invalid");
      return;
    }
    setFlow(id);
    void checkFlow(id);
  }, []);

  useEffect(() => {
    if (!flow) return;
    return listenForAuthCompletion(flow, (redirect) => window.location.assign(redirect));
  }, [flow]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setBusy(true);
    try {
      const response = await fetch("/auth/request-link", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flow, email }),
      });
      if (!response.ok) throw new Error("request failed");
      setView("sent");
    } catch {
      setMessage("送信を受け付けられませんでした。時間をおいて再度お試しください。");
    } finally {
      setBusy(false);
    }
  }

  async function continueAuth() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/auth/continue", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flow }),
      });
      if (response.status === 401) {
        await checkFlow(flow);
        return;
      }
      if (response.status === 409) {
        setMessage("認証の開始情報が無効になりました。最初からやり直してください。");
        setView("invalid");
        return;
      }
      if (!response.ok) throw new Error("continue failed");
      const result = await response.json() as { redirect?: string };
      if (!result.redirect) throw new Error("missing redirect");
      window.location.assign(result.redirect);
    } catch {
      setMessage("認証を続けられませんでした。再度お試しください。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title="学生ステータスを確認">
      <div className="notice">
        <span className="notice-icon" aria-hidden="true">✓</span>
        <div><strong>学生のみなさまへ</strong><p>大学から付与されたメールアドレスを入力してください。確認リンクを送ります。</p></div>
      </div>
      {view === "checking" && <p className="subtle" role="status">認証状態を確認しています…</p>}
      {view === "form" && (
        <form onSubmit={send}>
          <label htmlFor="email">メールアドレス</label>
          <input id="email" name="email" type="email" inputMode="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} />
          <button type="submit" disabled={busy}>送信</button>
        </form>
      )}
      {view === "sent" && (
        <div className="sent" role="status">
          <div className="sent-icon" aria-hidden="true">✉</div>
          <h2>メールをご確認ください</h2>
          <p>対象のアドレスには確認リンクを送りました。5分以内に、このブラウザでリンクを開いてください。</p>
          <p className="subtle">メールが届かない場合はアドレスを確認し、少し待ってから再度お試しください。</p>
        </div>
      )}
      {view === "existing" && (
        <div>
          <p>このブラウザは確認済みです。連携先へ進めます。</p>
          <button type="button" disabled={busy} onClick={continueAuth}>続ける</button>
          <button type="button" className="secondary" onClick={() => setView("form")}>別のメールで確認する</button>
        </div>
      )}
      {view === "error" && <button type="button" onClick={() => void checkFlow(flow)}>再試行</button>}
      <p className="message" role="alert">{message}</p>
      {(view === "checking" || view === "sent" || view === "invalid") && <HomeButton />}
      <p className="fine">メールの受信確認だけを行います。氏名やメールアドレスは収集されません。</p>
    </Shell>
  );
}
