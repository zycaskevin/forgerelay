# ChatGPT「再試一次」故障快照

當 ChatGPT Host 顯示「發生錯誤／再試一次」時，先不要重啟 ForgeRelay。立即執行：

```bash
forgerelay-retry-snapshot 5
```

參數是回看分鐘數，預設 5 分鐘。輸出會建立在 `/tmp/forgerelay-retry-<timestamp>/`，並同時產生 `.tar.gz`。

快照包含：

- ForgeRelay 版本、systemd state、restart count、PID
- 最近 ForgeRelay MCP / `resources/read` / MCP App / tool failure 記錄
- user/system cloudflared logs
- OOM、NVIDIA Xid、thermal、watchdog 與網路 reset 等系統風險
- 公開 `/mcp` 10 次 DNS / connect / TLS / TTFB / total latency probe
- 只抽取 MCP App 與錯誤事件的 `highlights.txt`

判讀順序：

1. 沒有 `resources/read`：Host/MCP metadata 或 Host lifecycle。
2. `resources/read` 非 200：ForgeRelay template/resource 層。
3. `resources/read` 200，但 asset fetch / public RTT 異常：tunnel / asset transport。
4. template 與 transport 都正常，但 Host 顯示錯誤：Host sandbox / MCP App renderer。
5. ForgeRelay service restart、OOM、Xid 或 thermal event：runtime / machine layer。

腳本不讀 OAuth owner token，也會對常見 token/secret/password/authorization 字串做基本遮罩。
