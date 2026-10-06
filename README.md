# IT部 学生ステータス確認

大学から付与されたメールアドレスの受信確認を行う認証サービスです。`verify.tmedit.org` で動作します。Next.js を使い、OpenNext で Cloudflare Workers に配備します。画面のロゴと配色は既存の `auth` に合わせています。

メールリンクで確認できるのは、そのアドレスでメールを受け取れることです。実在する人物の本人性は確認できません。低リスクの参加確認を想定しており、高い保証が必要な認証には使いません（[NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html)）。

## メールリンクで認証する

1. トップページから認証を開始すると、ブラウザを識別する Cookie を設定します。入力されたメールアドレスの形式を検査し、`AUTH_EMAIL_ALLOW_REGEX` に全体一致した場合だけ確認リンクを送ります。送信を受け付けるのは、認証開始から15分までです。対象外のアドレスや送信制限を超えた場合も、応答は同じ `{ "ok": true }` です。
2. 確認リンクには、ランダムな検証値を URL の `#` 以降（フラグメント）に入れます。リンクを開くだけでは認証は完了しません。認証を始めたブラウザで、送信から5分以内に確認ボタンを押すと、一度だけ使用できます。別のブラウザで開いた場合は、完全な URL をコピーして元のブラウザで開くよう案内します。認証フロー全体の有効期間は最長20分です。
3. 確認が完了すると、認証を始めたタブに完了画面を表示し、確認リンク側のタブは自動で閉じます。ブラウザが自動で閉じることを許可しない場合は、手動で閉じるよう案内します。元のタブがない場合は、確認リンク側に完了画面を表示します。

### 保存する情報

認証サービスのデータベース（D1）には、メールアドレスや氏名を保存せず、アカウント表も作りません。同じメールアドレスを識別するために、秘密鍵付きハッシュ（HMAC）を保存します。接続元 IP も HMAC に変換して送信制限に使い、メール用と IP 用で用途を分けています。

メールアドレスは ASCII の通常の形式を対象とします。前後の空白を除き、`@` より前の部分も含めて小文字に揃えます。この正規化規則や HMAC 鍵を変更すると、同じメールでも保存済みの識別値と一致しなくなるため、運用中は維持してください。

API はメールアドレスや共通の匿名 ID を返しません。`GET /me` も `{ "authenticated": boolean }` だけを返します。

### 認証は最大3ブラウザ、最長90日

同じメールで認証できるのは最大3ブラウザです。4台目を認証すると、最終利用が最も古いブラウザのセッションと、そのブラウザに紐づく全トークンを削除します。同じブラウザで再確認しても枠は増えません。再確認前に発行したトークンは失効します。

セッションは作成から90日、または最終利用から30日で失効します。ログアウトすると、現在のブラウザのセッションと関連トークンを失効させます。D1 の読み取りレプリカ API は使わず、失効を次回の照会に反映します。期限切れの行は毎日削除します。

`/auth/token` が返す `expires_in` は、セッション作成から90日までの残り秒数です。無操作、ログアウト、ブラウザ数の上限によって、それより早く失効することがあります。`POST /auth/introspect` は、照会時点でのトークンの有効性を返します。認可コード、トークン、セッション状態の応答には `Cache-Control: no-store` を付けています。

メール確認が完了すると、同じブラウザで進行中の他の確認フローも失効します。複数タブで同時に確認できるのは一つだけです。他のタブでは認証を開始し直してください。

### 認証開始とメール送信の回数を制限する

D1 にアクセスする前に、Cloudflare の Rate Limiting binding で認証開始とメール送信要求を制限します。それぞれ接続元 IP の HMAC ごとに1分600回、既存のブラウザ Cookie ごとに1分5回までです。大学などの共有回線を考慮し、IP 単位の制限は大量アクセス対策として緩めに設定しています。この上限は Cloudflare の拠点ごとに適用されます（[Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)）。

認証開始の制限を超えると、D1 にフローを作らず `429` と `Retry-After: 60` を返します。メール送信要求の制限を超えた場合は、通常と同じ応答を返します。実際の送信回数は D1 でも判定し、メールごとに1時間3回に制限します。この枠はブラウザや IP が変わっても共有されます。上限に達した D1 カウンターは更新しません。

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

規約・プライバシーポリシーのURL、認証ホスト、送信元は `wrangler.jsonc` の `vars` で管理します。画面で使う公開情報はビルド時に取り込みます。ブランド名とロゴのパスは `src/config.mjs`、ロゴは `public/brand.svg` にあります。変更後は再ビルド・再配備してください。配備スクリプトでドメインと送信元の binding 設定との一致を確認します。

確認メールのHTMLは `src/server/templates/verification.html` にあります。送信時に `{{LINK}}` を確認リンク、`{{MINUTES}}` を有効期間の分数、`{{ORGANIZATION_NAME}}` をブランド名に置換します。文言やデザインはこのファイルを編集してください。テキスト版は `src/server/email.ts` で管理します。

Worker のビルド時には、本番ビルドの Route Handler からHTMLメールを組み立て、送信処理まで到達することを確認します。検証では送信先とデータベースを模擬するため、実際のメールは送信しません。

## 本番に配備する

### メール送信とドメインを準備する

Cloudflare アカウントで、`verify.tmedit.org` を Email Sending の送信ドメインとして登録してください。任意の宛先への送信には、検証済み宛先だけに送る場合とは異なる利用条件があります（[Email Service の提供条件](https://developers.cloudflare.com/email-service/)）。

`wrangler.jsonc` には、送信元を `noreply@verify.tmedit.org` に限定した `EMAIL` binding と、D1、`verify.tmedit.org` の Custom Domain を設定しています。Custom Domain の DNS レコードと証明書は Cloudflare が作成します。同名ホストに既存の CNAME がある場合は、配備前に移行してください。

Cloudflare ダッシュボードの **Email Service → Sending domains → verify.tmedit.org → Email preview** を無効にしてください。Email Service は配送先アドレスと送信履歴を扱います。本文プレビューが有効だと、確認リンクを含む本文も保持されます。Worker にはメール、リンク、コード、トークンをログに出す処理を入れていません。ログ設定でもリクエスト本文や機密情報を含むクエリを記録しないでください。

エラーは **Workers & Pages → verify → Observability** で確認できます。API処理、メール送信、送信失敗時のリンク削除で発生したエラーは、固定の `event` 名を記録します。例外本文は記録しません。Workers Logs のサンプリング率は100%とし、実行ログとトレースは無効、クエリ文字列はマスクする設定です（[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)）。

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

配備スクリプトが Cloudflare Secrets Store を調べ、既存の Store が1つあれば名前によらず再利用します。Store がなければ `verify` という名前で作成します。複数ある場合は `verify` を選び、選択できなければ配備を停止します。

`wrangler.jsonc` に定義された client secret がなければ、それぞれ独立した64文字のランダム値を `workers` scope で作成します。既存の secret とその値は維持します。Store ID は配備時に取得して binding に設定するため、リポジトリの `wrangler.jsonc` に本番 ID を手で書く必要はありません。

本番の client secret は `.env`、`.dev.vars`、GitHub Secrets、ログには保存しません。

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

使い方は [API の使い方](docs/api.md) を参照してください。
