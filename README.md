# dsh-comfyui

DSHのComfyUI Operator、右パネルのComfyUI Studio、GPU側のMCP／REST Gatewayをまとめたプロジェクトです。ComfyUI本体・モデルは別途必要です。Gatewayの同梱は既存サーバーの自動更新や起動を行いません。

|場所|役割|
|---|---|
|`lib/`、`src/`|Operator、Studio、DSH用MCPブリッジ|
|`gateway/app/`|ComfyUIに接続するPython Gateway|
|`test/`、`gateway/tests/`|GPUを使用しない回帰テスト|

## DSHへ導入

```sh
npm ci
npm run build
# 既存のリモートGatewayに接続する場合
npm run connection -- --url https://YOUR-GATEWAY/mcp
npm run login
npm run verify
# DSHの対象profileへ追加
~/.local/bin/dsh plugin --profile desktop add "$PWD"
```

接続先の既定値は `http://127.0.0.1:8790/mcp` です。接続設定は
`~/.dsh/dsh-comfyui/connection.json` に保存します。HTTPS、またはloopback限定HTTPを使用できます。
`DSH_COMFYUI_MCP_URL`、`DSH_COMFYUI_AUTH_DIR`、`DSH_COMFYUI_NODE` の環境変数で上書きできます。
認証は既存GatewayのOAuthをmcp-remoteで使用します。Service Tokenの埋め込みは不要です。

DSHの **ComfyUI Operator** を選ぶと、Studio右パネルで成果物、API Graph、ノード定義に基づく入力編集を利用できます。
Graphはホイールで拡大縮小、空白ドラッグで移動できます。下書きは明示的に共有したものをAgentが読み取ります。
生成・保存は同じ実行経路を通り、送信IDによる重複防止と、不明な送信結果の照合を行います。
履歴・プレビュー・確定済み送信記録には件数／容量の上限があります。未確定の操作を履歴整理だけで再送可能にはしません。

## 同梱Gatewayを使う

GPUマシンでPython 3.12以上とuvを用意し、[Gatewayの説明](gateway/README.md)に従って設定します。

```sh
uv sync --project gateway
mkdir -p "$HOME/.config/dsh-comfyui"
cp gateway/.env.example "$HOME/.config/dsh-comfyui/gateway.env"
chmod 600 "$HOME/.config/dsh-comfyui/gateway.env"
# COMFY_URL、Access設定、許可利用者を編集
export DSH_COMFYUI_GATEWAY_ENV_FILE="$HOME/.config/dsh-comfyui/gateway.env"
npm run gateway:check
npm run gateway
```

既定で127.0.0.1:8790に待ち受け、認証未設定ならMCP／RESTへのアクセスを拒否します。
loopbackでの開発時のみ `GW_DEV_NO_AUTH=1 npm run gateway` を利用できます。
Cloudflare Access側のOAuth公開設定は別途必要です。Gateway自体はOAuth認可サーバーではありません。
MCPは `/mcp`、RESTは `/api/*` です。ワークフローの既存名への保存には明示的な `overwrite:true` が必要です。

```sh
npm run verify:discovery # 初期化・ツール一覧だけを確認、GPUへの照会なし
npm test               # PluginとGatewayの回帰テスト
```

## 公開・配布

接続先・認証・保存データはリポジトリ外で管理します。[設定一覧](docs/configuration.md)を参照してください。
開発用チェックアウトの過去履歴には環境固有情報が含まれる場合があるため、公開には履歴なしのexportを使用します。

```sh
npm run release:check
npm run release:export -- /absolute/path/to/dsh-comfyui-public
```

exportは許可したソースだけをコピーし、Git履歴・個人設定・認証キャッシュ・画像・ログ・依存環境を含めません。
出力先が存在する場合は上書きせず停止します。GitHub公開やnpmへのアップロードは行いません。

ライセンスは [MIT](LICENSE)。第三者由来の処理の帰属・ライセンスは [NOTICE](NOTICE) と
[参考実装](docs/prior-art.md)を参照してください。ComfyUI・モデル・custom nodeのライセンスは別途確認してください。
