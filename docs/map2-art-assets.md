# 地图2模拟建筑素材

本轮使用内置 `image_gen` 生成透明底 2.5D 建筑素材，存放于 `public/assets/map2/`：

- `song-hall-v1.png`：宋风殿堂
- `song-gate-v1.png`：宋风门楼
- `song-market-v1.png`：宋风店铺
- `song-pavilion-v1.png`：演出亭阁

素材均为风格示意，并非万岁山现场建筑的测绘复原。地图1的节点与道路仍决定位置、连通和导航结果，素材只提供视觉背景。

生成提示词以以下公共要求为基础，分别替换建筑主题：

> Create a single production-ready game map sprite asset: a historically inspired Chinese Song-dynasty scenic park [hall / gate / market shop / performance pavilion], viewed from a high 45-degree axonometric aerial angle (2.5D map view), three visible surfaces, realistic architectural proportions and fine roof-tile/eave detail, soft natural daylight, crisp silhouette, subtle contact shadow immediately below the building. Isolated SINGLE building centered with generous transparent margin. No terrain, roads, trees, people, labels, logos, icons, border, text, sheet divisions, or other objects. This will be placed over a navigation map; visually polished like a detailed 3D web map asset rather than a cartoon or flat diagram. Transparent background, true alpha.

不同主题的细节要求分别是：殿堂用深色瓦顶、浅色墙面和木构侧立面；门楼用城门墙体与双层屋檐；店铺用深色瓦顶、木构店面与低饱和红色挑檐；演出亭阁用开放柱廊和抬高的平台。
