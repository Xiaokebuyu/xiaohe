# 小合陪伴 · PLAN

> Living doc。每完成一步 update + commit。
> 完整设计背景（含 InkLoop 架构对齐、三层上下文、compact/memory 分工）见原始设计：
> `panel-workplace/dev/server/bot/xiaohe-agent-sdk/PLAN.md` §12。本文件是抽出独立 repo 后的精简执行版。

## 定位
独立陪伴型飞书 bot，替换原 panel 内嵌 bot。纯陪伴，不碰 panel 数据。人设=温柔知心的朋友。

## 架构基线（对齐 InkLoop）
API 无状态；状态全在每次现装的 system（纯静态人设 + cache_control）+ 现渲染的 user turn（`renderCompanionTurn`：记忆/专属上下文/召回/当前请求）。长延续靠召回不靠长 transcript。模型=MiniMax-M3（1M）。

## 三层上下文
- **session**：当前连续聊天窗口（可 compact/裁剪）。
- **专属上下文**：跨天关系状态（上次聊到哪/open loops/主动说过啥）——自己的 SQLite（`src/db/`，C3 起用）。
- **memory**：长期人物画像（`src/memory/` markdown）。

## Build order
- **C1 ✅ 已建（+2 路 codex review 硬化）**：反应式陪伴最小闭环。飞书 WS → 白名单私聊 → `runCompanionMessage`（静态人设 system + `renderCompanionTurn` 动态 turn + M3 + `remember_about_person` 工具 + companion 权限）→ 轻量流式卡。`npm run smoke` 12 项过。
  - review 落地（B 意图 + A 代码）：**短期连续对话历史**（`runtime/session.js`，TTL 滑动窗，解"第二句失忆"致命项）；**称呼映射**（`config/companions.js`，boundUser 带 display_name）；**生产空白名单拒启** + `XIAOHE_ALLOW_ALL_P2P`；**陪伴专用暖调卡**（`buildCompanionInitial/Done`，去绿勾/耗时/"值班"）；**streamer flush 串行化 + 收尾 await 在途**（防乱序/交错）；**health 反映飞书状态**（503）；群里 @ 回"只私聊陪你"；`XIAOHE_MEMORY_DIR` 持久化；panel 加 `DISABLE_BOT` 安全 cutover。
  - **未采纳**（核实后）：A1 长回复重复回复（旧生产 bot 同结构无此问题，WS 收即 ACK）；A3 WSClient onReady/onError（lark 无此构造 API，codex 猜的）。
  - **待真跑**：私聊验温度 + M3 流式/tool + 记忆写读 + 连续对话接得住"刚才"。
- **C2 ✅**（env 版）：白名单 + 称呼映射 `config/companions.js`（`XIAOHE_COMPANION_ALLOW_OPENIDS/NAMES`），boundUser 带 display_name，生产空白名单拒启。落 DB 管理后置。
- **C3 ✅**：专属上下文 SQLite（`db/index.js` + `companion/store.js`：people/turns/context/followups/hooks/outreach_log）。history 从库读（跨天/跨重启）；`renderPersonalContext`（上次聊到哪/没聊完的）注入 user turn。
- **C4 ✅**：idle distill（`companion/distill.js` + `idle-scheduler.js`）——静默 20 分钟把对话软信息蒸馏进 markdown memory + 更新 recent_summary。陪伴画像 prompt。
- **C5 ✅**（架构对位·轻量）：Claude 式 in-loop compact 在"每条消息 context 本就有界"的无状态架构无落点；等价做法=**滚动摘要**：长会话每 12 轮后台刷新 recent_summary（`countTurnsSinceContext` 用 turn id 判触发，避免同毫秒撞），跟 distill 共用摘要器、不同触发。
- **C6/C7 ✅**：主动关心（`companion/proactive-scheduler.js` + `proactive-decider.js` + `tools/reminder.js`）。`set_reminder` 工具让小合按用户话设**带上下文的钩子**（payload 存 about/note）；调度器每分钟扫到点钩子 → **规则硬门**（静默时段/20h 冷却/用户 30min 内活跃/上次没回）→ **LLM 软判断**（该不该关心+说什么）→ 发 DM + **记回 outbound turn**（小合记得自己主动说过）+ outreach 日志。
- **C8**（未做，可后置）：召回层——按当前话题从记忆/往事库捞相关片段注入 user turn（对齐 InkLoop 向量主题层）。白名单几个人时全量注入够用，人多了再做。

## 已知待验证
- **M3 流式 + tool use**：highspeed 实测过，M3 只在会议总结（非流式）用过。C1 真跑第一件事验，不行就 `BOT_COMPANION_MODEL=MiniMax-M2.7-highspeed` 降级。
- 轻量 streamer（`feishu/streamer.js`）是新写的（非旧 ChatCardStreamer），真跑看流式/收尾是否顺。

## 已砍（纯陪伴，相对旧 bot）
查工单/工单通知/绑定 panel 账号/会议纪要/巡检。要恢复见原 PLAN 二阶段（走 panel MCP）。
