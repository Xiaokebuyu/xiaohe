# 小合 · 陪伴

独立的有温度陪伴型飞书机器人。针对飞书中指定的人（白名单）执行陪伴型任务，对每个人有专属上下文与长期记忆。

从原 panel（DeskSkill TeamBoard）内嵌的 bot 抽出来独立成服务。**不碰 panel 业务数据**——纯陪伴。未来若要查工单等，走 panel MCP（二阶段）。

## 架构

- **无状态 harness**：`src/agent/` 内化 MiniMax 流式 loop（engine），厚 Tool 抽象 + 两层权限。API 无状态，状态全在**每次现装的 system + 现渲染的 user turn**（对齐 InkLoop `annotation-loop-demo`）。
- **静态/动态分离**：system = 纯静态人设（温柔知心的朋友，带 cache_control）；动态块（记忆/专属上下文/召回/当前请求）每轮渲染进 user turn（`renderCompanionTurn`）。
- **模型**：MiniMax-M3（百万上下文），`BOT_COMPANION_MODEL` 可降级。
- **记忆**：`src/memory/` per-user markdown（Public/Private 分段、大小上限、写锁）；对话中 `remember_about_person` 工具主动记，非只结束蒸馏。

## 目录

```
src/
  server.js            入口：飞书 WS → 白名单私聊 → 陪伴 harness → 流式卡
  config/env.js        .env 加载
  agent/               harness：engine / tool / tool-registry / permissions / prompts / runner
    tools/memory.js    remember_about_person 记忆工具
  memory/index.js      per-user markdown 记忆存储
  model/client.js      MiniMax（@anthropic-ai/sdk 兼容端点）
  feishu/              client（WS+卡片 API）/ cards（卡片模板）/ streamer（轻量流式）
  runtime/             concurrency（per-user mutex）/ degrade
  util/time.js         北京时间
  db/                  自己的 SQLite（C3 专属上下文起用，MVP 未用）
```

## 跑起来

```bash
npm install
cp .env.example .env      # 填 FEISHU_* 和 MINIMAX_*
npm start                 # node src/server.js
# 健康检查：curl localhost:3100/health
```

私聊小合发消息即触发陪伴（白名单为空时放行所有私聊）。

## 部署 / 替换现有服务

见 `CUTOVER.md`。核心：飞书同一 bot 应用**只能一个进程连 WS**，所以必须先停 panel 侧的内嵌 bot，再启本服务。

## 进度

见 `PLAN.md`。当前 = C1（反应式陪伴 + 记忆），待接 C2 白名单落库 / C3 专属上下文 / C5 compact / C6-7 主动关心。
