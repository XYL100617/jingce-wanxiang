'use strict';

// Ordered stop chains follow direct Map 1 graph edges. They use the current
// schematic graph as a demo reference and do not represent surveyed paths.
const routeSeeds = Object.freeze([
  { id: '8A3F', title: '亲子文化慢游', author: '示例路线', tags: ['亲子', '文化', '轻松', '多景点'], minutes: 205, likes: 286, stops: ['children_park', 'art_square', 'film_studio', 'juxianzhuang', 'shizipo', 'summit'], cover: 'children_park' },
  { id: '2C71', title: '短时经典打卡', author: '示例路线', tags: ['短时', '演艺', '文化', '街巷', '街区漫游'], minutes: 72, likes: 194, stops: ['market', 'water_street', 'theater'], cover: 'theater' },
  { id: 'F902', title: '湖畔染坊林地漫游', author: '示例路线', tags: ['自然', '拍照', '轻松', '亲水', '水岸风光'], minutes: 146, likes: 341, stops: ['lake', 'longtan', 'dyehouse', 'kuaipolin'], cover: 'lake' },
  { id: '61BD', title: '湖瀑到水浒街巷深度线', author: '示例路线', tags: ['自然', '深度游', '亲水', '长线', '多景点'], minutes: 335, likes: 0, stops: ['fortress', 'qianqiu_lake', 'lake', 'longtan', 'dyehouse', 'wangpo_island', 'market', 'water_street', 'theater', 'wanfo_tower'], cover: 'lake' },
  { id: '9E40', title: '宋韵街巷与古建文化长线', author: '示例路线', tags: ['文化', '演艺', '深度游', '多景点', '长线'], minutes: 360, likes: 0, stops: ['market', 'water_street', 'wulin_square', 'theater', 'wanfo_tower', 'temple', 'xianxia_square', 'xianxia_stage', 'juxianzhuang', 'film_studio', 'retro_block', 'puyi_wharf'], cover: 'theater' },
  { id: 'C3A8', title: '亲子互动展馆与城墙慢游', author: '示例路线', tags: ['亲子', '拍照', '文化', '深度游', '长线'], minutes: 295, likes: 0, stops: ['children_park', 'art_square', 'summit', 'shizipo', 'juxianzhuang', 'film_studio', 'retro_block', 'puyi_wharf'], cover: 'children_park' },
  { id: 'A7D2', title: '实景演艺与水浒街区巡游', author: '示例路线', tags: ['演艺', '文化', '深度游', '街巷', '长线'], minutes: 270, likes: 0, stops: ['fortress', 'hero_square', 'museum', 'theater', 'water_street', 'wulin_square', 'zhu_family_fort'], cover: 'fortress' },
  { id: 'D514', title: '花海栈道与湖畔摄影长线', author: '示例路线', tags: ['自然', '拍照', '深度游', '长线'], minutes: 245, likes: 0, stops: ['creative_market', 'forest_boardwalk', 'summit', 'art_square', 'flower_camp'], cover: 'forest_boardwalk' }
]);

module.exports = { routeSeeds };
