# Pet Health Tracker (pet-health-app)

家用寵物健康紀錄 App，跑在 EvanHome 上，家人連家中 Wi-Fi 就能用。

- 技術：Python 3.12 標準庫（零依賴）+ SQLite + 行動優先網頁
- 資料：`data/pet.db`（SQLite）、`data/photos/`（照片）
- 啟動：`python server.py`（port 8790，`PET_PORT` 可改）
- 開機自動啟動：`startup/PetHealth.vbs` 捷徑放 `shell:startup`
- 家人存取：`http://<EvanHome 家中 IP>:8790`（Tailscale：`http://100.94.244.112:8790`）

功能：多隻寵物、日常紀錄（體重/飲食/排便/體溫/症狀/活動＋照片）、
醫療紀錄（疫苗/用藥/就診/驅蟲/手術，下次日期提醒）、體重趨勢圖。

資料不在 repo 內（.gitignore），備份只要複製 `data/` 資料夾。
