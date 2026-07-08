# 替换现有小合服务（cutover）

## 现状
"现有的小合"不是独立服务——它跑在 panel（DeskSkill TeamBoard）服务器进程里：`dev/server/index.js` 启动时调 `startBot()`，跟 panel 的 REST/MCP/前端同属 PM2 app `deskskill`（或同一 Docker 容器）。

## 硬约束
飞书**同一个 bot 应用只能有一个进程持有 WS 长连接**。两个进程同时连会互相踢。所以 cutover 必须是**先停旧、再启新**，不能并存。

## 步骤

1. **部署本服务到服务器**（先不启动）
   ```bash
   # 在服务器上
   git clone <xiaohe repo> && cd xiaohe
   npm ci --omit=dev
   cp .env.example .env    # 填 FEISHU_*（跟旧 bot 同一套应用凭据）+ MINIMAX_*
   #                         设 XIAOHE_COMPANION_ALLOW_OPENIDS=<你的 openId>...
   ```

2. **停掉 panel 侧的内嵌 bot**（二选一）
   - 临时：在 panel `dev/server/index.js` 注释掉 `startBot()` 那行（约 index.js:112），重启 `deskskill`。panel 的 REST/前端不受影响。
   - 或：给 panel 加个 env 开关（如 `DISABLE_BOT=1`）包住 `startBot()`，重启。
   - 确认旧 bot 的飞书 WS 已断（panel 日志不再有 `[Bot/Feishu] WSClient 长连接已建立`）。

3. **启动本服务**
   ```bash
   pm2 start ecosystem.config.cjs   # app: xiaohe，单实例
   pm2 logs xiaohe                  # 看到 "陪伴服务已就绪" + "WSClient 长连接已建立"
   pm2 save
   ```

4. **验证**
   - 私聊小合发一句 → 收到温柔回应、卡片流式。
   - `curl localhost:3100/health` → `{ ok: true }`。

## 回滚
停 `pm2 delete xiaohe`（释放 WS）→ 恢复 panel 的 `startBot()` → 重启 `deskskill`。旧 bot 立刻回来。

## 注意
- 记忆文件：旧 bot 的 per-user 记忆在 `dev/server/bot/memory/`（未入库）。若想保留旧记忆，把 `user-*.md`/`anon-*.md` 拷到本服务 `src/memory/`。
- 纯陪伴**砍掉了**旧 bot 的：查工单/工单通知/绑定 panel 账号/会议纪要/巡检。确认这些确实不再需要（panel 近停用）。要恢复某些，见 dev/ 侧 PLAN 的二阶段。
