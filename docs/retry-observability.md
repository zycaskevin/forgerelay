# ChatGPT「再試一次」故障快照

當 ChatGPT Host 顯示「發生錯誤／再試一次」時，先不要重啟 ForgeRelay。立即執行：

```bash
forgerelay-retry-snapshot 5
```

參數是回看分鐘數，預設 5 分鐘。輸出會建立在 `/tmp/forgerelay-retry-<timestamp>/`，並同時產生 `.tar.gz`。

快照包含：

- ForgeRelay 版本、Activity Panel template revision、systemd state、restart count、PID
- 最近 ForgeRelay MCP / `resources/read` / MCP App / tool failure 記錄
- user/system cloudflared logs
- OOM、NVIDIA Xid、thermal、watchdog 與網路 reset 等系統風險
- 公開 `/mcp` 10 次 DNS / connect / TLS / TTFB / total latency probe
- 只抽取 MCP App 與錯誤事件的 `highlights.txt`

判讀順序：

1. 沒有 `resources/read`：Host/MCP metadata 或 Host lifecycle。
2. MCP 出現 408 / 429 / 5xx：transport 或 resource HTTP 層。
3. template revision 7 以上使用 inline bootstrap；此時 `resources/read` 成功而沒有主 JS/CSS asset fetch 是正常，不應再判成 renderer failure。
4. 舊版 external-bootstrap template 若 `resources/read` 成功但完全沒有 asset fetch，才偏向 Host renderer 在 asset 啟動前中斷。
5. template/transport 都正常但畫面仍錯誤：Host sandbox / UI runtime。
6. ForgeRelay service restart、OOM、Xid 或 thermal event：runtime / machine layer。

腳本不讀 OAuth owner token，也會對常見 token/secret/password/authorization 字串做基本遮罩。
