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

2. **停掉 panel 侧的内嵌 bot**（已加正式开关，别手改代码）
   - panel `dev/server/index.js` 已内置 `DISABLE_BOT` 开关。在 panel 的 env 里设 `DISABLE_BOT=1`，重启 `deskskill`。panel 的 REST/前端不受影响。
   - 确认旧 bot 的飞书 WS 已断（panel 日志出现 `DISABLE_BOT 已设，跳过内嵌 bot 启动`，且不再有 `[Bot/Feishu] WSClient 长连接已建立`）。

3. **启动本服务**
   ```bash
   pm2 start ecosystem.config.cjs   # app: xiaohe，单实例
   pm2 logs xiaohe                  # 看到 "陪伴服务已就绪" + "WSClient 长连接已建立"
   pm2 save
   ```

4. **验证**
   - `curl localhost:3100/health` → `{ ok: true, feishu: true }`（feishu:false / 503 = 没连上，别急着切）。
   - 私聊小合发一句 → 收到温柔回应、卡片流式。
   - 连续发第二句（如"那刚才那个呢"）→ 小合能接住"刚才"（验短期历史 session）。
   - 白名单里的人能聊；不在白名单的人收到"只陪固定朋友"婉拒。

## 回滚
停 `pm2 delete xiaohe`（释放 WS）→ 恢复 panel 的 `startBot()` → 重启 `deskskill`。旧 bot 立刻回来。

## 注意
- **记忆持久化（Docker 必看）**：默认记忆写在 `src/memory/`，容器重建会丢。生产用 Docker 时设 `XIAOHE_MEMORY_DIR=/data/xiaohe/memory` 并挂载卷。
- **旧记忆迁移**：旧 bot 的 per-user 记忆在 `dev/server/bot/memory/`（未入库）。拷 `user-*.md`/`anon-*.md` 到本服务记忆目录。⚠️ 注意：本服务当前按 openId 读 `anon-{openId}.md`（`boundUser` 只带称呼、无 username），所以旧的 `user-{username}.md` **不会自动命中**——要么把它改名成对应 `anon-{openId}.md`，要么等 C2 做完 openId→username 映射后再迁。
- **白名单/称呼**：生产务必设 `XIAOHE_COMPANION_ALLOW_OPENIDS`（否则 production 下拒启动）+ `XIAOHE_COMPANION_NAMES`（让小合知道在陪谁，否则温度会别扭）。
- 纯陪伴**砍掉了**旧 bot 的：查工单/工单通知/绑定 panel 账号/会议纪要/巡检。群里 @ 小合会收到"只在私聊陪你"的说明卡。要恢复某些能力，见 dev/ 侧 PLAN 的二阶段。
