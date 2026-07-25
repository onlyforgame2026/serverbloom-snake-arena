# ServerBloom Snake Arena

這是一套「唯一公開戰局」的多人貪吃蛇完整專案。

## 已完成規則

- 所有玩家只加入同一個公開戰局，沒有房間碼。
- 每局最多 12 人，可用 `MAX_PLAYERS` 環境變數調整為 2～20 人。
- 遊戲進行中加入者自動成為觀戰者。
- 本局結束後倒數 7 秒，所有在線玩家一起進入下一局。
- 玩家死亡後持續觀戰。
- 2 人以上是正式競技，最後生還者增加 1 勝。
- 僅 1 人時為自由練習，不計正式勝負。
- 電腦支援方向鍵與 WASD，手機支援觸控方向鍵。
- 伺服器權威判定移動、食物、碰撞與勝負，玩家不能只改前端作弊。
- 包含訊息大小限制、頻率限制、名稱清理、連線心跳與 Origin 檢查。

## 專案結構

```text
serverbloom-snake-arena/
├─ public/
│  ├─ index.html
│  ├─ styles.css
│  └─ app.js
├─ test/
│  └─ server.test.js
├─ server.js
├─ package.json
├─ render.yaml
└─ README.md
```

## 在自己的電腦測試

1. 安裝 Node.js 20 或更新版本。
2. 在此資料夾開啟終端機。
3. 執行：

```bash
npm install
npm test
npm start
```

4. 瀏覽器開啟：

```text
http://localhost:3000
```

要測試多人，可以同時開兩個瀏覽器，或讓同一個區域網路內的其他電腦開啟：

```text
http://你的電腦區網IP:3000
```

Windows 防火牆跳出詢問時，要允許 Node.js 使用私人網路。

## 部署到 Render

最簡單的方法是把整個資料夾上傳到 GitHub，再到 Render 建立 Blueprint 或 Web Service。

### Blueprint

專案已附上 `render.yaml`。在 Render 選擇 **New > Blueprint**，連接 GitHub 儲存庫即可。

### 手動建立 Web Service

- Runtime：Node
- Build Command：`npm install`
- Start Command：`npm start`
- Health Check Path：`/health`

部署後，直接打開 Render 提供的網址即可。前端與 WebSocket 伺服器會使用同一個網域，不需要另外填伺服器網址。

## 放入 ServerBloom 主網站

GitHub Pages 只能放靜態網頁，不能執行 Node.js WebSocket 伺服器。因此建議：

1. Snake Arena 整套部署在 Render。
2. ServerBloom 主網站加入一個按鈕連到 Render 網址。

```html
<a href="https://你的服務名稱.onrender.com" target="_blank" rel="noopener">
  進入 ServerBloom Snake Arena
</a>
```

也可以用 iframe 嵌入：

```html
<iframe
  src="https://你的服務名稱.onrender.com"
  title="ServerBloom Snake Arena"
  style="width:100%;height:85vh;border:0;border-radius:20px"
  allow="fullscreen">
</iframe>
```

## 前後端分開部署

前端也支援透過網址參數指定遠端 WebSocket：

```text
https://你的GitHubPages網址/?server=wss://你的Render服務.onrender.com/ws
```

若採用這種方式，請在 Render 設定環境變數：

```text
ALLOWED_ORIGINS=https://你的GitHubPages網域
```

多個網域用逗號分隔。

## 可調整環境變數

- `PORT`：伺服器連接埠，Render 會自動提供。
- `MAX_PLAYERS`：每局上限，預設 12，允許 2～20。
- `COUNTDOWN_SECONDS`：每局倒數，預設 7 秒。
- `TICK_MS`：移動速度，預設 125ms；越小越快。
- `BOARD_COLS`：地圖寬度，預設 72。
- `BOARD_ROWS`：地圖高度，預設 40。
- `ALLOWED_ORIGINS`：允許連線的前端網域，逗號分隔；同網域部署不需要設定。

## 目前資料保存方式

勝場只保存在玩家本次連線期間。伺服器重新啟動或玩家離線後，勝場會歸零。若要永久排行榜，下一階段要加入資料庫與登入系統。

## 未來自動開第二戰局

目前故意只開一個公開戰局，避免初期玩家被分散。未來超過 12～20 人時，可以把 `arena` 改為多個 Arena 實例，並以「先填滿第一場，再開第二場」的方式自動分流。
