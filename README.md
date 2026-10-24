# 寵物健康（pet-health-app）

家用寵物健康紀錄 App。記錄**多隻寵物**的日常（體重、飲食、排便、體溫、症狀、活動＋照片）
與醫療（疫苗、用藥、就診、驅蟲、手術，附「下次日期」提醒）。
打開網頁或加到 iPhone／Android 主畫面就能用。不登入時，資料只存在這台裝置；
登入 Google 並選定共用的雲端硬碟資料夾後，**兩個以上的家人可以共同編輯同一隻寵物的資料**，
離線時仍可修改，恢復網路後自動同步。

介面名稱「寵物健康」，套件與安裝識別名稱是 `pet-health-app`。

## 這一版做什麼

- 多隻寵物：上方標籤切換，每隻可加大头照、生日、體重單位（kg/g/lb）
- 日常紀錄：一般／體重／飲食／排便（5 級）／症狀／活動，可多張拍照
- 醫療紀錄：疫苗／用藥／就診／驅蟲／手術＋下次日期；首頁顯示**逾期／即將到期**，
  一鍵標記完成、一鍵排下次（疫苗與手術 ＋1 年，用藥與驅蟲 ＋1 月）
- 首頁卡片：年齡、最近體重（含增減）、距上次就診天數
- 體重趨勢圖
- 照片在裝置端壓縮（長邊 1280、JPEG 72%）才儲存與同步
- 可安裝的 PWA：離線開啟已載入的畫面；有新版本會跳出「請更新寵物健康」
- 家庭同步：Google 帳號登入 → 建立或加入共用 Drive 資料夾 → 家人各自登入選同一資料夾。
  衝突採 last-write-wins（以 updatedAt 為準），刪除寫 tombstone，不會被舊資料蓋回來

## 在本機開啟

需要 Node.js 20 以上。

```bash
npm install
npm run dev
```

瀏覽器打開終端顯示的網址（預設 `http://localhost:5173`）。

## 部署到 GitHub Pages

正式建置路徑是 `/pet-health-app/`：

```bash
npm run build:pages
```

推上 `main` 時 `.github/workflows/pages.yml` 會跑測試、產生圖示、建置並部署 Pages。
第一次要在倉庫 Settings → Pages 把 Source 選成 **GitHub Actions**。
正式網址：`https://evancho.github.io/pet-health-app/`

## 家庭同步設定（和食材櫃同一套）

1. Google Cloud Console 啟用 **Google Drive API**
2. OAuth 同意畫面（外部、測試中）範圍 `https://www.googleapis.com/auth/drive`，
   測試使用者加入每個家人的 Google 帳號
3. OAuth 用戶端 ID（網頁應用程式），已授權的 JavaScript 來源加入：
   - `https://evancho.github.io`
   - `http://localhost:5173`
   - `http://127.0.0.1:4173`
   （食材櫃用的同一個 client id 來源已包含這些，可直接共用）
4. 本機開發：`.env.local` 填 `VITE_GOOGLE_CLIENT_ID`；Pages：倉庫 Actions secret
   `VITE_GOOGLE_CLIENT_ID` 設同值，重新部署生效。沒有這個設定時網站維持單機模式。

## 資料放在哪

- 這台裝置：IndexedDB `pet-health-app`（records / photos / outbox）
- 雲端：共用 Drive 資料夾內 `pet-<id>.json`、`log-<id>.json`、`med-<id>.json`、`photo-<id>.jpg`
- 清除瀏覽器資料會遺失尚未同步的修改

## 測試

```bash
npm test
```

同步合併邏輯（last-write-wins、tombstone、outbox、照片差量）在 `src/merge.js`，
由 `src/merge.test.js` 覆蓋。

## 過渡說明

最早的第一版是 EvanHome 上的 Python 伺服器（`legacy-server.py`，已停用退役），
它的做法不符合需求（要在家才能連、無共同編輯），保留僅供參考，可隨時刪除。
