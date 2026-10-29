# 千帆语音合成与定位讲解

## 功能链路

- GPS 只在游客同意语音播报并勾选“到点讲解”后由当前浏览器读取，不上传经纬度到后端；若没有已核实坐标，页面不会申请或读取位置。
- 有效定位需精度不大于 50 米；游客进入最近的已核实景点围栏、至少收到 3 次定位且稳定停留 5 秒后，页面读取同一 `node_id` 的已审核景点简介，再调用服务端 TTS 并播放。
- 同一时刻只跟踪最近景点；已播报后，离开围栏及缓冲范围再进入才会重新触发，避免相邻景点重叠和 GPS 漂移导致连续重复播报。
- 未核实坐标或没有已审核简介的景点不会自动播报。
- 页面需保持打开并处于前台；浏览器/手机系统仍可能限制后台定位或自动播放。进入现场使用前须用目标手机实测。

## 百度千帆 TTS 配置

接口适配使用官方短文本语音合成 HTTP API：`POST https://tsn.baidu.com/text2audio`。服务端通过 `Authorization: Bearer ...` 发送 API Key，浏览器只调用本项目 `/api/companion/voice/tts`，不会接触密钥。

在本地进程或 Render 环境变量中设置：

```text
QIANFAN_TTS_API_KEY=<百度千帆语音合成 API Key>
QIANFAN_TTS_FREE_CONFIRMED=true
# 可选：应用自身每日调用保护上限，默认 100 次（缓存命中不计）
# QIANFAN_TTS_DAILY_REQUESTS=100
```

### 本机启动配置（PowerShell）

在项目目录的同一个 PowerShell 窗口中执行以下命令。输入 API Key 时不会回显；Key 只保存在当前终端进程环境中，不会写入项目文件：

```powershell
$secureKey = Read-Host "请输入百度千帆 API Key" -AsSecureString
$keyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
    $env:QIANFAN_TTS_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPtr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPtr)
    $secureKey.Dispose()
}
$env:QIANFAN_TTS_FREE_CONFIRMED = "true"
npm.cmd start
```

只有在百度控制台确认语音合成服务状态和可用额度后，才设置费用确认变量。该变量是本项目的调用开关，不代表百度承诺免费。服务启动后可访问 `http://localhost:4173/api/companion/voice` 查看 `qianfan_tts_ready`；测试播报可在陪伴页面开启“语音播报”并发送一条短问题。Key 不要粘贴到聊天、浏览器代码或 `.env.example`。

Windows PowerShell 5.1 用 `Invoke-RestMethod` 测试中文 JSON 时，建议先将请求体显式转成 UTF-8 字节，避免系统默认代码页把中文转坏；浏览器端 `fetch` 使用 UTF-8 JSON，不受这条命令行注意事项影响：

```powershell
$json = @{ text = "欢迎来到万岁山武侠城。请按照自己的节奏游览，祝您游览愉快。"; voice = "guide" } | ConvertTo-Json -Compress
$body = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
$result = Invoke-RestMethod -Method Post -Uri "http://localhost:4173/api/companion/voice/tts" -ContentType "application/json; charset=utf-8" -Body $body
$audio = [Convert]::FromBase64String($result.audio_base64)
"类型：$($result.mime_type)；字节数：$($audio.Length)"
```

### Render 配置

在 Render 对应 Web Service 的 **Environment** 中新增 `QIANFAN_TTS_API_KEY`（值填控制台生成的 API Key）和 `QIANFAN_TTS_FREE_CONFIRMED=true`，保存后触发一次部署。部署完成后检查 `/api/companion/voice` 的 `qianfan_tts_ready`。Render 环境变量只影响云端服务；本机终端变量与 Render 相互独立。不要把 Key 写进 GitHub 仓库。

### 控制台检查

千帆 API Key 使用百度智能云 API Key 鉴权。进入百度智能云控制台的 API Key 管理页，确认该 Key 对应的 AI 开放能力服务权限包含语音合成，并核对服务开通状态、音库和计费/免费额度。千帆 API Key 与传统云资源 AK/SK 不同；本适配只使用 API Key。接口与鉴权细节见[百度千帆短文本语音合成文档](https://cloud.baidu.com/doc/qianfan-api/s/5m7stbv04)和[百度云 API Key 鉴权说明](https://cloud.baidu.com/doc/AI_REFERENCE/s/Hm5us339w)。

第二个变量是明确的费用闸门。设置前应在百度控制台确认服务状态、选择音色的可用额度，并确认超额后的计费选项。应用默认每天最多发起 100 次上游请求（失败请求也会计入）；重复文本命中进程内缓存，不发起新请求。计数和缓存随服务重启清空，因此这是应用侧保护限额，不替代云账号预算/欠费保护。缺失任一配置时，服务不会调用千帆；前端可回退到浏览器本机语音播报。API Key 不得放入 `public/` 文件或提交到 Git。

基础音色按讲解风格选择：小明/小五使用度小宇， 小红使用度小美，小李使用度逍遥，小王使用度丫丫。音色 ID 来自百度短文本语音合成接口文档；免费额度可能因音库而异。

## 景点 GPS 坐标

坐标清单为 `public/poi-gps.json`。地图1的 `algorithm_x` / `algorithm_y` 是手绘示意图坐标，不能换算为现场经纬度。当前清单为空，所以 GPS 代码已接入，但不会误触发任何景点讲解。

取得景区 GIS 数据或现场测量后，按以下格式加入点位；`node_id` 必须复用 `server/data/scenic_graph.json` 中的地图1 ID：

```json
{
  "node_id": "museum",
  "latitude": 0,
  "longitude": 0,
  "radius_m": 35,
  "verification_status": "verified",
  "source": "景区GIS数据或测量记录编号"
}
```

将示例中的经纬度替换为核实值后才可标记 `verified`。坐标系统须为 WGS84。建议逐个景点测量游客可到达的步道入口点，而不是建筑中心；现场按目标手机的定位误差调整 20–100 米范围，并检查相邻景点不会互相误触发。

## 主要限制

- 千帆密钥、服务权限和免费额度必须由项目运营者在百度控制台申请并配置；代码不能替账号开通或代确认免费额度。
- 当前仓库没有万岁山各 POI 的现场核实 WGS84 坐标。收到景区 GIS/测量数据前，只能验证接口与定位流程，不能完成真实景点地理围栏验收。
- 手机定位需要 HTTPS（本地 `localhost` 可用于开发）。定位权限或定位服务报错后可重新开启重试；页面切至后台、锁屏、系统省电策略、浏览器自动播放策略都会影响持续触发；此实现不承诺后台锁屏导航。
