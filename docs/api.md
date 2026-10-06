# API の使い方

メールリンクによる認証と、認証状態を利用するための基本的な手順です。利用するアプリの `client_id`、戻り先、client secret は、事前に認証サービスへ登録されている必要があります。

## 共通事項

- POST の本文は JSON とし、`Content-Type: application/json` を指定します。
- client secret はサーバーで管理し、ブラウザへ渡しません。
- ブラウザ用 API は認証ホストの Cookie を使います。POST には許可された `Origin` が必要です。
- 認証関連の応答は `no-store` です。コードやトークンをキャッシュやログに残さないでください。
- メールアドレスや共通の匿名 ID は返しません。

## 1. 認証を開始する

アプリ側でランダムな `state` と PKCE verifier を作り、ブラウザを `GET /auth/authorize` へ移動します。

| クエリ | 内容 |
| --- | --- |
| `client_id` | 登録済みのアプリ識別子 |
| `redirect_uri` | 登録済みの戻り先と完全に一致する URL |
| `state` | 開始時と戻り時の対応を確認するランダム値 |
| `code_challenge` | PKCE verifier の SHA-256 を Base64URL で表した値（パディングなし） |
| `code_challenge_method` | `S256` |

`state` と verifier は、開始したブラウザと紐づけて安全に保持します。`state` は英数字・`_`・`-` の32〜256文字、verifier は同じ文字種の43〜128文字を使います。保持期間は、認証フローの最長20分と認可コードの有効期間5分を合わせた25分を目安にします。

メールの入力と確認は認証サービスの画面で行います。確認後、戻り先に `code` と `state` が付いて返されます。保存した `state` と一致することを確認してから、コードを交換してください。

## 2. コードをトークンに交換する

サーバーから `POST /auth/token` を呼びます。本文には `client_id`、`client_secret`、`code`、開始時の `code_verifier`、同じ `redirect_uri` を指定します。

成功時は `access_token`、`token_type: "Bearer"`、`expires_in`（秒）を返します。コードの有効期間は5分で、交換は一度だけです。

トークンは、アプリ自身のホストに限定した HttpOnly・Secure Cookie などで保持します。`expires_in` はセッションの90日上限までの残り時間であり、無操作やログアウトなどで早く失効することがあります。

## 3. 認証状態を照会する

保護対象のリクエストごとに、サーバーから `POST /auth/introspect` を呼びます。本文は `client_id`、`client_secret`、`token` です。

応答は `{ "active": boolean }` です。`true` の場合に処理を続け、`false` の場合に再認証を求めます。別のアプリに発行されたトークンは利用できません。

`GET /me` は認証ホストのブラウザ Cookie を使い、`{ "authenticated": boolean }` を返します。アプリが保持するトークンの照会には `/auth/introspect` を使ってください。

## 4. ログアウトする

ブラウザから認証ホストの `POST /auth/logout` を呼び、Cookie を送信します。別オリジンから呼ぶ場合は `credentials: "include"` を指定し、呼び出し元が許可されている必要があります。本文は空の JSON オブジェクトで構いません。

成功時は `{ "ok": true }` を返し、現在のブラウザのセッションと関連トークンを失効させます。成功を確認してから、アプリ側に保持したトークンを削除してください。認証ホストの Cookie が必要なため、アプリのサーバーから代理で呼んでもブラウザのログアウトにはなりません。

## 認証画面が使う API

通常は認証サービスの画面が次の API を呼びます。

| API | 入力 | 用途・応答 |
| --- | --- | --- |
| `GET /` | なし | 単独の認証を開始し、入力画面へ移動する |
| `GET /auth/flow` | クエリ `flow` | フローの有効性とブラウザの認証状態を返す |
| `POST /auth/request-link` | `{ flow, email }` | 送信を受け付ける。対象外や制限超過でも `{ "ok": true }` を返す |
| `GET /link?flow=…#token=…` | メールのリンク | 確認画面を開く。フラグメントはサーバーに送られない |
| `POST /auth/link/status` | `{ flow, token }` | リンクを消費せず、`status` に `ready`・`other_browser`・`invalid` を返す |
| `POST /auth/confirm` | `{ flow, token }` | 同じブラウザでリンクを消費し、`{ ok: true, redirect }` を返す |
| `POST /auth/continue` | `{ flow }` | 認証済みブラウザで確認を省略し、`{ ok: true, redirect }` を返す |

メールリンクは送信から5分で失効し、一度だけ使えます。送信受付の正常応答は、配送の完了を保証するものではありません。リンクの状態が `invalid` の場合は認証をやり直し、`other_browser` の場合は元のブラウザで開くよう案内します。

## エラーの扱い

HTTP ステータスを確認してから、応答を成功として扱ってください。

| 応答 | 対応 |
| --- | --- |
| `400 / invalid_authorization_request` | 認証開始のパラメーターを確認する |
| `400 / invalid_grant` | コードの失効・再利用、PKCE、戻り先を確認する |
| `401 / unauthorized_client` | client secret と登録設定を確認する |
| `403 / forbidden` | ブラウザ用 API の呼び出し元を確認する |
| `409` | フローの失効や競合を確認し、必要に応じて認証をやり直す |
| `429` | 認証開始の制限。`Retry-After` に従って待つ |
| `5xx`・通信失敗 | 一時障害として扱い、認証 Cookie を維持する |

`/auth/token` のクライアント認証エラーではコードを消費しません。有効期限内なら、設定を修正して交換を再試行できます。DB 処理が失敗して変更が取り消された場合も同様です。ただし、応答を受け取れなかった通信失敗では、交換が完了した可能性があります。再試行が `invalid_grant` になった場合は認証をやり直してください。

照会の `5xx` や通信失敗は、`{ "active": false }` と区別します。障害時に認証成功とみなしたり、保持したトークンを削除したりしないでください。
