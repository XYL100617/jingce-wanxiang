# 用户与管理者基础契约

## 身份与权限

| 角色 | 能力 | 当前限制 |
| --- | --- | --- |
| `guest` | 读景区信息、试算路线、使用演示导航 | 不保存个人资料或路线；不能修改全园状态 |
| `visitor` | 游客能力、保存个人设置与路线记录、提交自己的进度 | 不能封路、关闭景点、取消演出或查看他人资料 |
| `manager` | 游客能力、修改景区环境状态、查看用户摘要与审计日志 | 不能从接口取得密码哈希；尚未实现细分岗位授权 |

`/api/v1/scenario-event`、`/api/simulate-event`、`/api/simulate-road-closure` 以及 `/api/b/demo-event` 中的 `POI_CLOSED`、`QUEUE_UPDATE`、`ROAD_CLOSED`、`ROAD_OPENED`、`EVENT_CANCELLED` 只允许管理者调用。`PROGRESS_UPDATE`、`POSITION_UPDATE`、`REQUEST_REPLAN` 等游客操作保持可用。服务器负责校验权限，页面隐藏按钮只是辅助。

## 账号 API

| 方法与路径 | 请求 | 返回 |
| --- | --- | --- |
| `POST /api/account/register` | `{username,password,displayName?}` | `{user,profile}` 并设置 HttpOnly 会话 Cookie |
| `POST /api/account/login` | `{username,password}` | `{user,profile}` 并设置会话 Cookie |
| `POST /api/account/logout` | `{}` | `{ok:true}` 并清除 Cookie |
| `GET /api/account/me` | — | `{user,profile}`；访客的 `profile` 为 `null` |
| `PATCH /api/account/profile` | `{displayName?,consent?}` | `{profile}`；需要登录 |
| `GET /api/admin/users` | — | `{users}`；需要管理者 |
| `GET /api/admin/audit` | — | `{entries}`，最近 100 条；需要管理者 |

账号 ID 为 UUID，角色只能由服务端创建。公开用户对象包含 `id,username,displayName,role,permissions`，个人资料另含 `consent,preferences,routeHistory`。账号名为 3–32 位小写字母、数字或下划线；密码为 8–128 位，通过 scrypt 加盐哈希保存。会话只在服务进程内保留，服务重启后需要重新登录。管理员通过启动前设置 `ADMIN_USERNAME` 与 `ADMIN_PASSWORD` 初始化，没有默认管理员密码。

`consent` 包含 `location`、`feedback`、`sharing` 三个布尔字段；默认全为 `false`。当前它们是资料记录字段，后续 B/C 模块在读取定位、保存反馈或发布 DNA 前还须接入授权检查。退出登录不会删除账号记录。

## 路线与个人数据

登录账号调用 `POST /api/preferences` 后，服务端把推断出的偏好资料和 `planId,createdAt,stops` 路线摘要保存到账号下，最多留 30 条。访客试算不保存。A、B、C 对个人数据写入时以服务端 `req.account.id` 为归属键，不接受浏览器传入的 `user_id` 代替身份。

现有景区状态与规划器游客状态仍是**单份共享演示状态**；这次基础模块尚未把 `/api/preferences`、实时进度、陪伴上下文改为完全按账号隔离。多人同时使用时可能影响彼此的当前路线。三人并行开发时应把这些运行时状态迁移到按用户 ID 隔离的会话或存储层，再上线多人使用。当前 2.5D 地图的道路仍是示意路网，不能声称为实地导航数据。

## 操作记录

每条日志为一行 JSON（JSONL），字段固定为：`timestamp`（ISO 8601）、`requestId`（UUID）、`actorId`（账号 UUID 或 null）、`actorRole`、`action`、`target`（节点/道路/账号 ID 或 null）、`outcome`（`success`/`denied`）、`details`（不含密码、Cookie、完整请求体）。目前记录账号注册、登录、退出、个人设置变更、路线进度、景区状态变更和越权尝试。日志文件默认为 `server/data/audit.local.jsonl`，已加入 `.gitignore`。后续接入管理后台、真实应急事件时沿用此格式。

账号文件与日志文件都是单机基础存储，适合当前三人并行开发和本地演示；多进程部署、备份、会话持久化、密码重置和日志轮转仍需在正式部署前补齐。
