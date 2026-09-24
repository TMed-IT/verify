# IT部 学生ステータス確認

大学から付与されたメールアドレスの受信確認を行う認証サービスです。`verify.tmedit.org` で動作し、`tmedit.org`、`atnd.tmedit.org`、`cs.tmedit.org` と連携します。Next.js を使い、OpenNext で Cloudflare Workers に配備します。画面のロゴと配色は既存の `auth` に合わせています。

メールリンクで確認できるのは、そのアドレスでメールを受け取れることです。実在する人物の本人性は確認できません。低リスクの参加確認を想定しており、高い保証が必要な認証には使いません（[NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html)）。

## メールリンクで認証する

1. 連携先が、開始時と戻り時の対応を確認する `state` と、認可コードの横取りを防ぐ PKCE S256 の値を作ります。ブラウザを `GET /auth/authorize` に転送し、認証を開始します。戻り先は各連携先の HTTPS `/auth/verify/callback` に固定しています。
2. 認証サービスがブラウザを識別する Cookie を設定します。入力されたメールアドレスの形式を検査し、`AUTH_EMAIL_ALLOW_REGEX` に全体一致した場合だけ確認リンクを送ります。送信を受け付けるのは、認証開始から15分までです。対象外のアドレスや送信制限を超えた場合も、応答は同じ `{ "ok": true }` です。
3. 確認リンクには、ランダムな検証値を URL の `#` 以降（フラグメント）に入れます。リンクを開くだけでは認証は完了しません。認証を始めたブラウザで、送信から5分以内に確認ボタンを押すと、一度だけ使用できます。別のブラウザで開いた場合は、完全な URL をコピーして元のブラウザで開くよう案内します。認証フロー全体の有効期間は最長20分です。
4. 確認が完了すると、認証サービスが有効期間5分の認可コードと元の `state` を連携先に返します。連携先サーバーは共有の秘密値（client secret）と PKCE verifier を使い、`POST /auth/token` でコードをトークンに交換します。交換できるのは一度だけです。
5. 連携先はトークンを、自分のホストでのみ使える HttpOnly・Secure Cookie に保存します。保護対象の各リクエストで `POST /auth/introspect` を呼び、トークンが有効か確認します。応答は `{ "active": boolean }` だけです。

### 保存する情報

認証サービスのデータベース（D1）には、メールアドレスや氏名を保存せず、アカウント表も作りません。同じメールアドレスを識別するために、秘密鍵付きハッシュ（HMAC）を保存します。接続元 IP も HMAC に変換して送信制限に使い、メール用と IP 用で用途を分けています。

メールアドレスは ASCII の通常の形式を対象とします。前後の空白を除き、`@` より前の部分も含めて小文字に揃えます。この正規化規則や HMAC 鍵を変更すると、同じメールでも保存済みの識別値と一致しなくなるため、運用中は維持してください。

連携先に渡すトークンは、連携先ごとに異なる値です。メールアドレスや共通の匿名 ID は返しません。`GET /me` も `{ "authenticated": boolean }` だけを返します。

### 認証は最大3ブラウザ、最長90日

同じメールで認証できるのは最大3ブラウザです。4台目を認証すると、最終利用が最も古いブラウザのセッションと、そのブラウザに紐づく全連携先のトークンを削除します。同じブラウザで再確認しても枠は増えません。再確認前の連携先トークンは失効します。

セッションは作成から90日、または最終利用から30日で失効します。ログアウトすると、現在のブラウザのセッションと関連トークンを失効させます。D1 の読み取りレプリカ API は使わず、失効を次回の照会に反映します。期限切れの行は毎日削除します。

`/auth/token` が返す `expires_in` は、セッション作成から90日までの残り秒数です。無操作、ログアウト、ブラウザ数の上限によって、それより早く失効することがあります。連携先は `expires_in` だけで判断せず、各リクエストで `/auth/introspect` を呼んでください。認可コード、トークン、セッション状態の応答には `Cache-Control: no-store` を付けています。

メール確認が完了すると、同じブラウザで進行中の他の確認フローも失効します。複数タブで同時に確認できるのは一つだけです。他の連携先では認証を開始し直し、認証済みブラウザの「続ける」から進めてください。

### 認証開始とメール送信の回数を制限する

D1 にアクセスする前に、Cloudflare の Rate Limiting binding で認証開始とメール送信要求を制限します。それぞれ接続元 IP の HMAC ごとに1分60回、既存のブラウザ Cookie ごとに1分5回までです。この上限は Cloudflare の拠点ごとに適用されます（[Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)）。

認証開始の制限を超えると、D1 にフローを作らず `429` と `Retry-After: 60` を返します。メール送信要求の制限を超えた場合は、通常と同じ応答を返します。実際の送信回数は D1 でも判定し、メールごとに1時間3回、IP ごとに15分10回に制限します。上限に達した D1 カウンターは更新しません。

Rate Limiting の namespace ID は、次の固定値を使います。

| binding | 本番 | ローカルテスト |
| --- | --- | --- |
| `FLOW_START_IP` | `1001` | `2001` |
| `FLOW_START_BROWSER` | `1002` | `2002` |
| `REQUEST_LINK_IP` | `1003` | `2003` |
| `REQUEST_LINK_BROWSER` | `1004` | `2004` |

namespace ID はアカウント内で共有されるため、本番配備前に他の Worker で使われていないことを確認してください。同じ ID と key を使うとカウンターを共有します（[namespace ID の仕様](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/#configuration)）。

## ローカルで開発する

```sh
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
# .dev.vars の値をローカル用に設定する
pnpm run db:schema:local
pnpm run dev
```

`http://localhost:3000` で起動します。ポートを変える場合は `PORT=3001 pnpm run dev` を使います。`PUBLIC_ORIGIN` は開発スクリプトが設定するので、`.dev.vars` には書かないでください。

変更後は次のコマンドで確認します。`deploy:check` は OpenNext のビルドと Wrangler の dry run を行います。

```sh
pnpm run typecheck
pnpm test
pnpm run deploy:check
```

画面は `app/` と `components/`、認証 API は `app/auth/` の Route Handler と `src/server/` にあります。`custom-worker.ts` は OpenNext の Worker に、D1 の期限切れデータを毎日削除する処理を追加します。

コード交換とトークン照会を試す場合は、ローカル用の client secret も登録します。3つの secret には、それぞれ異なるテスト用ランダム値を設定してください。本番の値はローカルに自動共有されません。

```sh
pnpm exec wrangler secrets-store secret create 00000000000000000000000000000000 --name CLIENT_SECRET_MAIN --scopes workers
pnpm exec wrangler secrets-store secret create 00000000000000000000000000000000 --name CLIENT_SECRET_ATND --scopes workers
pnpm exec wrangler secrets-store secret create 00000000000000000000000000000000 --name CLIENT_SECRET_CS --scopes workers
```

コマンドの Store ID は、`wrangler.jsonc` に設定したローカル用 ID です。

## 本番に配備する

### メール送信とドメインを準備する

Cloudflare アカウントで、`verify.tmedit.org` を Email Sending の送信ドメインとして登録してください。送信用サブドメインは個別に登録します（[サブドメインの設定](https://developers.cloudflare.com/email-service/configuration/subdomains/#add-a-subdomain-to-email-sending)）。任意の宛先への送信には、検証済み宛先だけに送る場合とは異なる利用条件があります（[Email Service の提供条件](https://developers.cloudflare.com/email-service/)）。

`wrangler.jsonc` には、送信元を `noreply@verify.tmedit.org` に限定した `EMAIL` binding と、D1、`verify.tmedit.org` の Custom Domain を設定しています。Custom Domain の DNS レコードと証明書は Cloudflare が作成します。同名ホストに既存の CNAME がある場合は、配備前に移行してください。

Cloudflare ダッシュボードの **Email Service → Sending domains → verify.tmedit.org → Email preview** を無効にしてください。Email Service は配送先アドレスと送信履歴を扱います。本文プレビューが有効だと、確認リンクを含む本文も保持されます。Worker にはメール、リンク、コード、トークンをログに出す処理を入れていません。ログ設定でもリクエスト本文や機密情報を含むクエリを記録しないでください。

### `.env` に本番設定を保存する

D1 ID、メール許可正規表現、HMAC 鍵は、`auth` と同じく dotenvx で暗号化した `.env` に保存します。暗号化済みの `.env` は公開リポジトリに含めます。復号鍵の `.env.keys` は Git に入れず、安全な場所に保管してください。鍵を失うと設定を復号できません。

まず `pnpm exec wrangler d1 create verify` で D1 を作成します。返された `database_id` を、次の手順で `.env` の `D1_DATABASE_ID` に設定してください。

```sh
pnpm exec dotenvx decrypt --no-native --no-armor -f .env
# .env の各値を本番用に編集する
pnpm exec dotenvx encrypt --no-native --no-armor -f .env
```

リポジトリの `.env` には、初期状態では暗号化したプレースホルダーが入っています。編集後はすぐに再暗号化し、平文のままコミットしないでください。

| 設定 | 値 |
| --- | --- |
| `D1_DATABASE_ID` | 作成した D1 の UUID |
| `AUTH_EMAIL_ALLOW_REGEX` | 許可するメールアドレスの正規表現。全体一致で判定する。例: `^[^@]+@example\.org$` |
| `HMAC_SECRET` | 32文字以上のランダム値。再配備でも同じ値を維持する |

配備スクリプトは、未設定の値、無効な D1 ID や正規表現、短すぎる HMAC 鍵を拒否します。値をログや CLI 引数には出しません。

### client secret は Secrets Store で管理する

配備スクリプトが Cloudflare Secrets Store を調べ、`verify` という Store を選びます。同名の Store がなければ作成します。

`CLIENT_SECRET_MAIN`、`CLIENT_SECRET_ATND`、`CLIENT_SECRET_CS` がなければ、それぞれ独立した64文字のランダム値を `workers` scope で作成します。既存の secret は維持します。Store ID は配備時に取得して binding に設定するため、リポジトリの `wrangler.jsonc` に本番 ID を手で書く必要はありません。

連携先 Worker も同じアカウントの Secrets Store に binding を設定し、対応する secret を読み取ります。本番の client secret は `.env`、`.dev.vars`、GitHub Secrets、ログには保存しません。

### GitHub Actions で配備する

GitHub に次の値を登録します。

| GitHub 設定 | 種類 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Variable |
| `CLOUDFLARE_API_TOKEN` | Secret |
| `DOTENV_PRIVATE_KEY_VERIFY` | Secret |

`DOTENV_PRIVATE_KEY_VERIFY` は Organization Secrets に登録し、このリポジトリからの利用を許可してください。値は `.env.keys` の `DOTENV_PRIVATE_KEY` です。workflow は、dotenvx が使う環境変数名 `DOTENV_PRIVATE_KEY` に渡します。鍵の値はログに出さないでください。

Cloudflare API token には、対象アカウントの Worker と D1 を更新する権限を与えます。Store と secret の一覧取得・作成・binding には **Account Secrets Store Edit** 権限も必要です。

`main` への push、または手動実行で配備します。型検査、テスト、依存パッケージの監査、OpenNext のビルドと dry run が通ると、配備設定を検証します。その後、Secrets Store を準備し、[schema.sql](schema.sql) を D1 に適用して Worker を配備します。

ローカルから配備する場合も同じ処理を使います。

```sh
pnpm run deploy:config:check
pnpm run deploy
```

配備時には、D1 ID と本番の Store ID を入れた一時 Wrangler 設定と、Worker secret ファイルを作ります。どちらも処理後に削除します。Git で管理する `wrangler.jsonc` には、本番の D1 ID や秘密値を書き込みません。

## API

| API | 用途 |
| --- | --- |
| `GET /auth/authorize` | `client_id`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256` を受ける |
| `POST /auth/request-link` | ブラウザから `{ flow, email }` を受ける |
| `GET /link?flow=…#token=…` | メールのリンク。フラグメントはサーバーへ送られない |
| `POST /auth/link/status` | `{ flow, token }` を本文で受け、未消費のまま `ready`・`other_browser`・`invalid` を返す |
| `POST /auth/confirm` | 同じブラウザから `{ flow, token }` を受け、認証を完了する |
| `POST /auth/continue` | 認証済みブラウザの `{ flow }` から認可コードを発行する |
| `POST /auth/token` | 連携先サーバーから `{ client_id, client_secret, code, code_verifier, redirect_uri }` を受ける |
| `POST /auth/introspect` | 連携先サーバーから `{ client_id, client_secret, token }` を受ける |
| `GET /me` | 認証状態のみ返す |
| `POST /auth/logout` | 現在の認証ブラウザと関連する全トークンを失効する |

`/auth/token` と `/auth/introspect` は、連携先サーバーから呼び出してください。client secret をブラウザの JavaScript に置かないでください。

### 障害時は認証 Cookie を維持する

Secrets Store の読み取り失敗や D1 障害には HTTP 500 を返します。連携先は 5xx や通信失敗を一時障害として扱い、Cookie を維持して再試行できるようにしてください。

照会の HTTP 401 は、連携先の認証情報や設定を確認すべき応答です。正常応答で `{ active: false }` が返った場合に再認証へ進めます。

コード交換では、トークン作成とコード消費を D1 の batch 内で行います。途中で DB 処理が失敗し、変更が取り消された場合は、同じコードを再試行できます（[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)）。

## 連携先 Worker に認証を組み込む

次の例は、認証開始、コード交換、トークン照会、ログアウトを実装したものです。連携先のアプリはこのリポジトリには含まれません。

| 連携先 | `CLIENT_ID` | `APP_ORIGIN` | `secret_name` |
| --- | --- | --- | --- |
| tmedit.org | `tmedit` | `https://tmedit.org` | `CLIENT_SECRET_MAIN` |
| atnd.tmedit.org | `atnd` | `https://atnd.tmedit.org` | `CLIENT_SECRET_ATND` |
| cs.tmedit.org | `cs` | `https://cs.tmedit.org` | `CLIENT_SECRET_CS` |

各連携先の `wrangler.jsonc` に、配備ログで確認した Store ID と対応する `secret_name` を設定します。`VERIFY_CLIENT_SECRET` は、secret を読み取るための binding 名です。Store ID は機密値ではありません。

```jsonc
"secrets_store_secrets": [
  { "binding": "VERIFY_CLIENT_SECRET", "store_id": "YOUR_STORE_ID", "secret_name": "CLIENT_SECRET_MAIN" }
]
```

コールバックは `/auth/verify/callback` に固定します。開始時に保存するフロー Cookie は、認証フローの最長20分とコードの有効期間5分を合わせて25分保持します。

```ts
interface AppEnv {
  CLIENT_ID: "tmedit" | "atnd" | "cs";
  APP_ORIGIN: string;
  VERIFY_CLIENT_SECRET: SecretsStoreSecret;
}

const verify = "https://verify.tmedit.org";
const flowCookie = "__Host-verify_flow";
const tokenCookie = "__Host-verify_token";
const random = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const digest = async (value: string) => {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const readCookie = (request: Request, name: string) => {
  const part = (request.headers.get("Cookie") || "").split("; ").find(item => item.startsWith(`${name}=`));
  return part ? part.slice(name.length + 1) : null;
};
const setCookie = (name: string, value: string, age: number) =>
  `${name}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
const callback = (env: AppEnv) => `${env.APP_ORIGIN}/auth/verify/callback`;
const unavailable = () => new Response("Authentication temporarily unavailable. Please retry.", {
  status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" },
});
async function verifyRequest(env: AppEnv, path: string, values: Record<string, string>): Promise<Response> {
  try {
    return await fetch(`${verify}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...values, client_id: env.CLIENT_ID,
        client_secret: await env.VERIFY_CLIENT_SECRET.get() }),
    });
  } catch {
    return unavailable();
  }
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/auth/start" && request.method === "GET") {
      const state = random();
      const verifier = random();
      const target = new URL(`${verify}/auth/authorize`);
      target.searchParams.set("client_id", env.CLIENT_ID);
      target.searchParams.set("redirect_uri", callback(env));
      target.searchParams.set("state", state);
      target.searchParams.set("code_challenge", await digest(verifier));
      target.searchParams.set("code_challenge_method", "S256");
      return new Response(null, { status: 302, headers: {
        Location: target.toString(),
        "Set-Cookie": setCookie(flowCookie, `${state}.${verifier}`, 25 * 60),
        "Cache-Control": "no-store",
      } });
    }

    if (url.pathname === "/auth/verify/callback" && request.method === "GET") {
      const saved = readCookie(request, flowCookie)?.split(".");
      const code = url.searchParams.get("code");
      if (!saved || saved.length !== 2 || url.searchParams.get("state") !== saved[0] || !code) {
        return new Response("Invalid state", { status: 400, headers: { "Cache-Control": "no-store" } });
      }
      const result = await verifyRequest(env, "/auth/token", {
        code, code_verifier: saved[1], redirect_uri: callback(env),
      });
      if (result.status >= 500) return unavailable();
      if (!result.ok) return new Response("Invalid code", { status: 400, headers: { "Cache-Control": "no-store" } });
      let data: { access_token?: string };
      try { data = await result.json(); } catch { return unavailable(); }
      if (!data.access_token) return unavailable();
      const headers = new Headers({ Location: "/", "Cache-Control": "no-store" });
      headers.append("Set-Cookie", setCookie(flowCookie, "", 0));
      headers.append("Set-Cookie", setCookie(tokenCookie, data.access_token, 90 * 86400));
      return new Response(null, { status: 303, headers });
    }

    if (url.pathname === "/auth/logout" && request.method === "POST") {
      return new Response(null, { status: 204, headers: {
        "Set-Cookie": setCookie(tokenCookie, "", 0), "Cache-Control": "no-store",
      } });
    }

    // 実際のアプリでは、保護対象の各リクエストでこの照会を行う。
    const token = readCookie(request, tokenCookie);
    if (!token) return Response.redirect(`${env.APP_ORIGIN}/auth/start`, 302);
    const result = await verifyRequest(env, "/auth/introspect", { token });
    if (result.status >= 500) return unavailable();
    if (!result.ok) return new Response("Authentication client configuration error", {
      status: 502, headers: { "Cache-Control": "no-store" },
    });
    let status: { active?: boolean };
    try { status = await result.json(); } catch { return unavailable(); }
    if (status.active === false) return Response.redirect(`${env.APP_ORIGIN}/auth/start`, 302);
    if (status.active !== true) return unavailable();
    return new Response("Authenticated", { headers: { "Cache-Control": "no-store" } });
  },
};
```

### ログアウトはブラウザから認証ホストへ送る

ブラウザから認証ホストの `/auth/logout` を呼び、成功を確認してから連携先のトークン Cookie を削除します。認証ホストの Cookie はそのホストでのみ送られるため、連携先サーバーからの代理リクエストではログアウトできません。

```js
const revoked = await fetch("https://verify.tmedit.org/auth/logout", {
  method: "POST", credentials: "include",
  headers: { "Content-Type": "application/json" }, body: "{}",
});
if (!revoked.ok) throw new Error("Verify logout failed");
await fetch("/auth/logout", { method: "POST" });
location.assign("/");
```

連携先の Cookie が残っていても、認証ホストでトークンが失効していれば、次の照会で `{ "active": false }` が返ります。
