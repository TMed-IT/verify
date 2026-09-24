"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/shell";

type View = "checking" | "authenticated" | "unauthenticated" | "error";

export default function VerifiedPage() {
  const [view, setView] = useState<View>("checking");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function checkStatus() {
    setView("checking");
    try {
      const response = await fetch("/me", { cache: "no-store" });
      if (!response.ok) throw new Error("status check failed");
      const result = await response.json() as { authenticated?: boolean };
      if (typeof result.authenticated !== "boolean") throw new Error("invalid status");
      setView(result.authenticated ? "authenticated" : "unauthenticated");
    } catch {
      setView("error");
    }
  }

  useEffect(() => { void checkStatus(); }, []);

  async function logout() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/auth/logout", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!response.ok) throw new Error("logout failed");
      window.location.assign("/");
    } catch {
      setMessage("ログアウトに失敗しました。");
      setBusy(false);
    }
  }

  return (
    <Shell title={view === "authenticated" ? "確認済み" : "認証状態を確認"}>
      {view === "authenticated" && <div className="notice"><span className="notice-icon" aria-hidden="true">✓</span><div><strong>メールの確認が完了しました</strong><p>このブラウザの認証は有効です。連携先からの認証を続ける場合は、連携先の画面に戻ってください。</p></div></div>}
      <p className="subtle" role="status">{view === "checking" ? "状態を確認しています…" : view === "authenticated" ? "このブラウザは確認済みです。" : view === "unauthenticated" ? "このブラウザの認証は有効ではありません。" : "認証状態を確認できませんでした。再度お試しください。"}</p>
      {view === "error" && <button type="button" disabled={busy} onClick={() => void checkStatus()}>再試行</button>}
      <button type="button" className="secondary" disabled={busy} onClick={logout}>このブラウザからログアウト</button>
      <p className="message" role="alert">{message}</p>
    </Shell>
  );
}
