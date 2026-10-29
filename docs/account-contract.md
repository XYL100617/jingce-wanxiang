# 用户与管理者基础契约

## 身份与权限

| 角色 | 能力 | 当前限制 |
| --- | --- | --- |
| `guest` | 读景区信息、试算路线、使用演示导航 | 不保存个人资料或路线；不能修改全园状态 |
| `visitor` | 游客能力、保存个人设置与路线记录、提交自己的进度 | 不能封路、关闭景点、取消演出或查看他人资料 |
| `manager` | 修改景区环境状态、审核公开路线、查看用户摘要与审计日志 | 不使用游客点赞、收藏、打卡和投稿接口；不能自助删除管理员账号 |

`/api/v1/scenario-event`、`/api/simulate-event`、`/api/simulate-road-closure` 以及 `/api/b/demo-event` 中的 `POI_CLOSED`、`QUEUE_UPDATE`、`ROAD_CLOSED`、`ROAD_OPENED`、`EVENT_CANCELLED` 只允许管理者调用。`PROGRESS_UPDATE`、`POSITION_UPDATE`、`REQUEST_REPLAN` 等游客操作保持可用。服务器负责校验权限，页面隐藏按钮只是辅助。

## 账号 API

| 方法与路径 | 请求 | 返回 |
| --- | --- | --- |
| `POST /api/account/register` | `{username,password,displayName?}` | `{user,profile}` 并设置 HttpOnly 会话 Cookie |
| `POST /api/account/login` | `{username,password}` | `{user,profile}` 并设置会话 Cookie |
| `POST /api/account/logout` | `{}` | `{ok:true}` 并清除 Cookie |
| `GET /api/account/me` | — | `{user,profile}`；访客的 `profile` 为 `null` |
| `PATCH /api/account/profile` | `{displayName?,consent?}` | `{profile}`；需要登录 |
| `GET /api/account/export` | — | 导出账号资料、偏好、规划历史和游客个人中心数据；不含审计日志、第三方模型处理记录或共享演示运行状态 |
| `DELETE /api/account/me` | `{password}` | 普通游客用当前密码删除账号、个人中心数据及本人投稿；管理员不可自助删除 |
| `GET /api/admin/users` | — | `{users}`；需要管理者 |
| `GET /api/admin/audit` | — | `{entries}`，最近 100 条；需要管理者 |

账号 ID 为 UUID，角色只能由服务端创建。普通游客获得 `community:interact` 与 `community:publish`；管理者获得 `community:moderate`、`community:publish`、景区管理与审计能力。管理者可以提交公开路线推荐，但仍不能使用游客点赞、收藏、打卡和个人互动接口。公开用户对象包含 `id,username,displayName,role,permissions`，个人资料另含 `consent,preferences,routeHistory`。账号名为 3–32 位小写字母、数字或下划线；密码为 8–128 位，通过 scrypt 加盐哈希保存。会话只在服务进程内保留，服务重启后需要重新登录。管理员通过启动前设置 `ADMIN_USERNAME` 与 `ADMIN_PASSWORD` 初始化，没有默认管理员密码。旧版演示管理员 `scenic_admin` 会在无 `admin` 账号冲突时自动改名为 `admin`，原账号 ID 与密码哈希保持不变。

`consent` 包含 `location`、`feedback`、`sharing` 三个布尔字段；默认全为 `false`。路线公开发布和主页公开展示必须显式开启 `sharing`；陪伴使用已保存路线/偏好另有逐次对话授权，位置仍不随该选项发送。退出登录不会删除账号记录。

## 路线 DNA 社区与个人记录

| 方法与路径 | 用途 | 权限/边界 |
| --- | --- | --- |
| `GET /api/route-dna?tags=文化,亲子` | 按全部所选特点筛选示例DNA与游客公开路线 | 公开只读；特点标签为 `亲子、文化、演艺、美食、拍照、轻松、深度游、短时、自然`；游客路线返回点赞/收藏总数及当前用户状态，热门景点返回点赞/收藏数 |
| `POST /api/community/routes` | 发布 `{title,description?,stops,tags}` | 普通游客或管理者账号且 `sharing=true`；特点须选 1–5 个受控标签；节点必须是地图1统一图的可规划景点，当前模拟路网逐段可达才接受 |
| `POST /api/community/routes/:id/like` | 点赞/取消点赞 | 普通游客账号；同一账号最多一票 |
| `POST /api/community/routes/:id/favorite` | `{saved:boolean}` 收藏/取消收藏路线 | 普通游客账号 |
| `GET /api/route-dna` 示例路线 | 示例 DNA 每个连续景点点位在当前地图1统一图中有直接连边；地图几何和距离仍是示意资料 |
| `POST /api/dna/clone` | 结合当前状态按 DNA 景点顺序调用同一规划器 | 返回实际采用的模板景点和未采用点位；遇到剩余时间不足、关闭或不可达时只返回可执行的连续前缀，不跳点伪装成完整模板路线 |
| `POST /api/community/poi-favorites` | `{node_id,saved:boolean}` 收藏/取消收藏景点 | 普通游客账号；只接受统一图 POI 节点 |
| `POST /api/community/poi-likes` | `{node_id,liked:boolean}` 点赞/取消点赞景点 | 普通游客账号；只接受统一图 POI 节点；与景点收藏独立计数 |
| `POST /api/community/checkins` | 打卡 `{node_id}` | 普通游客账号；只接受统一图 POI 节点；当前是游客自报演示记录 |
| `POST /api/community/views` | `{node_id}` 记录最近浏览景点 | 普通游客账号；只接受统一图 POI 节点；由个人中心景点选择触发，保留最近 30 个去重记录 |
| `GET /api/community/me` | 读取自己的景点/路线收藏、景点/路线点赞、发布路线统计、打卡和最近浏览 | 普通游客账号 |
| `GET /api/community/profiles/:username` | 查看公开主页和其发布路线 | 对方必须开启 `sharing=true` |
| `GET /api/admin/community/routes` | 查看所有投稿路线及审核状态 | 管理者 |
| `PATCH /api/admin/community/routes/:id` | `{status:"hidden"}` 下架路线或 `{status:"published"}` 恢复公开 | 管理者；写入操作审计 |
| `GET /api/operations` | 读取当前有效公告和共享演示事件 | 公开只读；事件与公告均标明演示来源 |
| `GET /api/admin/announcements` | 查看公告记录及审核状态 | 管理者 |
| `POST /api/admin/announcements` | 创建带有效期的公告 | 管理者；新公告可先保存为待审核 |
| `PATCH /api/admin/announcements/:id` | `{review_status:"approved"|"pending"}` | 管理者；状态变化写审计 |
| `DELETE /api/admin/announcements/:id` | 删除公告 | 管理者；写审计 |

社区内容存储于 `server/data/community.local.json`（可用 `COMMUNITY_FILE` 指定），运营公告存储于 `server/data/operations.local.json`（可用 `OPERATIONS_FILE` 指定）。它们是单机 JSON 演示存储，不适合多实例部署；路线通达校验使用项目模拟路网，不代表现场测绘验证。DNA 复制提取路线特点与种子主题偏好，再调用同一 B 规划器基于当前图、状态和预测重算，不直接复用陈旧道路路径。

## 路线与个人数据

登录账号调用 `POST /api/preferences` 后，服务端把推断出的偏好资料和 `planId,createdAt,stops` 路线摘要保存到账号下，最多留 30 条。访客试算不保存。A、B、C 对个人数据写入时以服务端 `req.account.id` 为归属键，不接受浏览器传入的 `user_id` 代替身份。

现有景区状态与规划器游客状态仍是**单份共享演示状态**；这次基础模块尚未把 `/api/preferences`、实时进度、陪伴上下文改为完全按账号隔离。多人同时使用时可能影响彼此的当前路线。三人并行开发时应把这些运行时状态迁移到按用户 ID 隔离的会话或存储层，再上线多人使用。当前 2.5D 地图的道路仍是示意路网，不能声称为实地导航数据。

## 操作记录

每条日志为一行 JSON（JSONL），字段固定为：`timestamp`（ISO 8601）、`requestId`（UUID）、`actorId`（账号 UUID 或 null）、`actorRole`、`action`、`target`（节点/道路/账号 ID 或 null）、`outcome`（`success`/`denied`）、`details`（不含密码、Cookie、完整请求体）。目前记录账号注册、登录、退出、个人设置变更、路线进度、景区状态变更和越权尝试。日志文件默认为 `server/data/audit.local.jsonl`，已加入 `.gitignore`。后续接入管理后台、真实应急事件时沿用此格式。

账号文件与日志文件都是单机基础存储，适合当前三人并行开发和本地演示；多进程部署、备份、会话持久化、密码重置和日志轮转仍需在正式部署前补齐。
