# 既存Pluginの調査とv0.3への反映

調査日: 2026-10-18。公開GitHubのREADMEだけでなく、下記のソースを確認。
他Pluginのインストール・起動やコードの転載は行っていません。
設計上のアイディアを参考に、このPluginのMCP／OAuth構成に合わせて独自実装しています。

| 参考元 | 確認したソース | 採用・判断 |
| --- | --- | --- |
| [fandc520/dsh-comfyui](https://github.com/fandc520/dsh-comfyui) (MIT) | `src/params.ts`, `src/queue.ts`, `src/client/panel.tsx`。commit `3440ad6787f5de4b76925a7f3766388d96786380` | 頻用パラメーターの抽出、手動追加、履歴からの再利用を参考に、クイック調整／ピン留め／実行時グラフの復元を追加。ワークフローの絞り込みも追加。 |
| [zeroa234/dsh-comfyui](https://github.com/zeroa234/dsh-comfyui) (BSD-3-Clause) | `lib/lib/scan.js`, `lib/lib/engine.js`。commit `05c5690ce77aecc026210715739e1fca23d3a13d` | 操作対象をノードID＋入力名で特定する設計と実行前確認を参考にした。既存MCPのノード・リンク・候補値検証を維持し、パネルAPI側にINT/FLOAT/BOOLEAN/STRINGと数値上下限の確認を追加。 |
| [nana7mi0721/dsh-comfyui-agent](https://github.com/nana7mi0721/dsh-comfyui-agent) (MIT) | `README.md`, `lib/graph.js`, `lib/tools.js`。commit `2f12ad14b35a74bc4508354c5e6dad520a216c9d` | 子グラフ展開と特殊widget変換は参考になるが、完全なノード定義・生のキャンバス構造が必要。現在のMCPとの責任分担を保ち、クライアントへの変換器の二重実装は見送った。seed=0など明示値を保持する方針も確認。 |

`wbin0001/dsh-comfyui-canvas` はPlugin索引に掲載されていたものの、
今回GitHub本体・git取得ともにRepository not foundとなったため、ソース比較対象から除外。

## 挙動と制約

- クイック調整は現在グラフの値を直接変更し、通常のUndo/Redo・検証・下書き保護を利用する。
  prompt/text、seed、steps、cfg、denoise、width/heightなどを抽出する。
  positive/negativeの意味をノード順から決めつけず、ノードIDと題名を表示する。
  文字列・数値・真偽値の任意入力もピン留め可能。リンクは対象外。
- ピン留めはセッションのブラウザ下書きに保存。MCPサーバーへのワークフロー保存や
  APIグラフ単体のJSON書き出しには含めない。別ワークフローの読み込み時はリセットする。
- v0.3以後にPluginが観測した `run_workflow` の明示グラフだけを実行時点で保存。
  ポーリングやライブラリ変更で書き換えない。実行時のseedを含む入力をそのまま戻せる。
  入力上書きと、サーバーが返すランダムseedの確定値も反映する。
  過去ジョブやgenerate_image等でグラフが取得できないジョブには復元ボタンを出さない。
- 復元は下書きへの読み込みのみ。GPU実行は実行ボタンで明示する。
  編集中の下書きがあれば復元を拒否し、保存・書き出し・破棄を先に求める。
- 検証時は接続先からノード定義を再取得する。数値の型と範囲を確認し、
  自動丸め・自動補正はしない。候補の省略リストだけでモデル不存在を判定せず、
  完全な候補値は既存MCPの検証に任せる。
  この接続先の仕様に合わせ、seed/noise_seedの `-1` はランダム指定として許可する。
- これは公開前の比較・改善であり、互換性や独自性を網羅的に保証するものではない。
