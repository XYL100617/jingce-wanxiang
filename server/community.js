'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { routeSeeds } = require('./dna-seeds');

const ROUTE_TAGS = Object.freeze(['亲子', '文化', '演艺', '美食', '拍照', '轻松', '深度游', '短时', '自然', '亲水', '街巷', '长线', '多景点', '水岸风光', '街区漫游']);
const DNA_SEED_IDS = new Set(routeSeeds.map(seed => seed.id));

function createCommunity({ file = process.env.COMMUNITY_FILE || path.join(__dirname, 'data', 'community.local.json'), now = () => new Date().toISOString() } = {}) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    data = { schema_version: 1, routes: [], users: {} };
  }
  data.routes ||= [];
  data.users ||= {};
  for (const user of Object.values(data.users)) {
    user.favorite_pois ||= [];
    user.liked_pois ||= [];
    user.favorite_routes ||= [];
    user.liked_routes ||= [];
    user.checkins ||= [];
    user.recent_views ||= [];
  }
  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  function userData(userId) {
    data.users[userId] ||= { favorite_pois: [], liked_pois: [], favorite_routes: [], liked_routes: [], checkins: [], recent_views: [] };
    return data.users[userId];
  }
  function routeSummary(route, viewerId = null) {
    return { id: route.id, title: route.title, description: route.description, stops: route.stops,
      tags: route.tags, author: route.authorName, author_username: route.authorUsername,
      created_at: route.createdAt, likes: route.likes.length, favorites: data.users ? Object.values(data.users).filter(value => value.favorite_routes?.includes(route.id)).length : 0,
      liked: Boolean(viewerId && route.likes.includes(viewerId)), saved: Boolean(viewerId && userData(viewerId).favorite_routes.includes(route.id)),
      graph_version: route.graphVersion, validation: 'reachability_checked_at_publish_on_demo_network' };
  }
  function listRoutes(viewerId = null, isShareable = () => true, filters = {}) {
    const requestedTags = Array.isArray(filters.tags) ? filters.tags : [];
    return data.routes.filter(route => route.status === 'published' && isShareable(route.authorUsername) && requestedTags.every(tag => (route.tags || []).includes(tag)))
      .map(route => routeSummary(route, viewerId))
      .sort((a, b) => b.likes + b.favorites - a.likes - a.favorites || b.created_at.localeCompare(a.created_at));
  }
  function popularPois(nodes, viewerId = null) {
    const counts = new Map();
    for (const value of Object.values(data.users)) {
      for (const id of value.favorite_pois || []) { const item = counts.get(id) || { favorites: 0, likes: 0 }; item.favorites++; counts.set(id, item); }
      for (const id of value.liked_pois || []) { const item = counts.get(id) || { favorites: 0, likes: 0 }; item.likes++; counts.set(id, item); }
    }
    return [...counts].map(([node_id, count]) => ({ node_id, name: nodes.get(node_id) || node_id, ...count, liked: Boolean(viewerId && userData(viewerId).liked_pois.includes(node_id)), saved: Boolean(viewerId && userData(viewerId).favorite_pois.includes(node_id)) }))
      .sort((a, b) => b.likes + b.favorites - a.likes - a.favorites || a.name.localeCompare(b.name, 'zh-CN')).slice(0, 10);
  }
  function publishRoute(user, input, graphVersion, validateStops) {
    if (!user || user.consent?.sharing !== true) throw Object.assign(new Error('请先登录并在个人中心开启路线公开分享授权'), { statusCode: 403 });
    const title = String(input?.title || '').trim();
    const description = String(input?.description || '').trim();
    const stops = input?.stops;
    if (title.length < 2 || title.length > 60) throw Object.assign(new Error('路线名称须为 2–60 字'), { statusCode: 400 });
    if (description.length > 300) throw Object.assign(new Error('路线说明不能超过 300 字'), { statusCode: 400 });
    const tags = input?.tags;
    if (!Array.isArray(tags) || tags.length < 1 || tags.length > 5 || tags.some(tag => !ROUTE_TAGS.includes(tag)) || new Set(tags).size !== tags.length)
      throw Object.assign(new Error(`路线特点须从以下标签选择 1–5 个：${ROUTE_TAGS.join('、')}`), { statusCode: 400 });
    if (!Array.isArray(stops) || stops.length < 2 || stops.length > 20 || stops.some(id => typeof id !== 'string') || new Set(stops).size !== stops.length)
      throw Object.assign(new Error('路线须包含 2–20 个不重复景点节点'), { statusCode: 400 });
    if (data.routes.filter(item => item.authorId === user.id).length >= 50)
      throw Object.assign(new Error('每个账号最多发布 50 条路线，请整理已有推荐后再发布'), { statusCode: 429 });
    const validation = validateStops(stops);
    if (!validation?.valid) throw Object.assign(new Error(validation?.error || '当前示意路网无法验证这条路线'), { statusCode: 422 });
    const route = { id: crypto.randomUUID(), title, description, stops: [...stops], tags: [...tags],
      authorId: user.id, authorName: user.displayName, authorUsername: user.username, likes: [], createdAt: now(), graphVersion, status: 'published' };
    data.routes.push(route);
    persist();
    return routeSummary(route, user.id);
  }
  function setMembership(user, listName, id, enabled) {
    if (!user) throw Object.assign(new Error('请先登录'), { statusCode: 401 });
    const list = userData(user.id)[listName];
    const index = list.indexOf(id);
    if (enabled && index < 0) list.push(id);
    if (!enabled && index >= 0) list.splice(index, 1);
    persist();
    return [...list];
  }
  function seedSummary(seed, viewerId = null) {
    const users = Object.values(data.users);
    return { ...seed,
      likes: users.filter(value => value.liked_routes?.includes(seed.id)).length,
      favorites: users.filter(value => value.favorite_routes?.includes(seed.id)).length,
      liked: Boolean(viewerId && userData(viewerId).liked_routes.includes(seed.id)),
      saved: Boolean(viewerId && userData(viewerId).favorite_routes.includes(seed.id)) };
  }
  function setSeedMembership(user, listName, seedId, enabled) {
    if (!user) throw Object.assign(new Error('请先登录'), { statusCode: 401 });
    if (!DNA_SEED_IDS.has(seedId)) throw Object.assign(new Error('没有找到这条 DNA 示例路线'), { statusCode: 404 });
    if (!['liked_routes', 'favorite_routes'].includes(listName)) throw Object.assign(new Error('不支持的路线互动类型'), { statusCode: 400 });
    return setMembership(user, listName, seedId, enabled);
  }
  function toggleLike(user, routeId) {
    if (!user) throw Object.assign(new Error('请先登录'), { statusCode: 401 });
    const route = data.routes.find(item => item.id === routeId && item.status === 'published');
    if (!route) throw Object.assign(new Error('没有找到这条公开路线'), { statusCode: 404 });
    const index = route.likes.indexOf(user.id);
    if (index >= 0) route.likes.splice(index, 1); else route.likes.push(user.id);
    persist();
    return routeSummary(route, user.id);
  }
  function moderateRoute(routeId, status) {
    if (!['published', 'hidden'].includes(status)) throw Object.assign(new Error('status 只能是 published 或 hidden'), { statusCode: 400 });
    const route = data.routes.find(item => item.id === routeId);
    if (!route) throw Object.assign(new Error('没有找到这条路线'), { statusCode: 404 });
    route.status = status;
    route.moderatedAt = now();
    persist();
    return { ...routeSummary(route), status: route.status, moderated_at: route.moderatedAt };
  }
  function listForModeration() {
    return data.routes.map(route => ({ ...routeSummary(route), status: route.status, author_username: route.authorUsername }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  function deleteUserData(userId) {
    const removedRouteIds = new Set(data.routes.filter(route => route.authorId === userId).map(route => route.id));
    data.routes = data.routes.filter(route => route.authorId !== userId);
    for (const route of data.routes) route.likes = (route.likes || []).filter(id => id !== userId);
    delete data.users[userId];
    for (const value of Object.values(data.users)) {
      value.favorite_routes = (value.favorite_routes || []).filter(id => !removedRouteIds.has(id));
    }
    persist();
    return { removed_routes: removedRouteIds.size };
  }
  function checkin(user, nodeId, nodeName) {
    if (!user) throw Object.assign(new Error('请先登录'), { statusCode: 401 });
    const list = userData(user.id).checkins;
    const today = now().slice(0, 10);
    const existing = list.find(item => item.node_id === nodeId && item.date === today);
    if (existing) return existing;
    const item = { id: crypto.randomUUID(), node_id: nodeId, node_name: nodeName, date: today, created_at: now(), mode: 'visitor_self_reported_demo' };
    list.unshift(item);
    userData(user.id).checkins = list.slice(0, 200);
    persist();
    return item;
  }
  function recordView(user, nodeId, nodeName) {
    if (!user) throw Object.assign(new Error('请先登录'), { statusCode: 401 });
    const own = userData(user.id);
    const item = { node_id: nodeId, node_name: nodeName, viewed_at: now() };
    own.recent_views = [item, ...(own.recent_views || []).filter(view => view.node_id !== nodeId)].slice(0, 30);
    persist();
    return item;
  }
  function me(user) {
    if (!user) throw Object.assign(new Error('请先登录'), { statusCode: 401 });
    const own = userData(user.id);
    const publishedRoutes = data.routes.filter(route => route.authorId === user.id);
    const likedCommunityRoutes = data.routes.filter(route => route.likes.includes(user.id)).map(route => route.id);
    const likedRoutes = [...new Set([...(own.liked_routes || []), ...likedCommunityRoutes])];
    return { favorite_pois: [...own.favorite_pois], liked_pois: [...(own.liked_pois || [])], favorite_routes: [...own.favorite_routes], liked_routes: likedRoutes, checkins: [...own.checkins], recent_views: [...(own.recent_views || [])],
      stats: { favorite_pois: own.favorite_pois.length, liked_pois: (own.liked_pois || []).length, favorite_routes: own.favorite_routes.length, liked_routes: likedRoutes.length, published_routes: publishedRoutes.length, likes_received: publishedRoutes.reduce((sum, route) => sum + route.likes.length, 0) },
      published_routes: publishedRoutes.map(route => ({ ...routeSummary(route, user.id), status: route.status })) };
  }
  function publicProfile(username, lookupUser) {
    const user = lookupUser(username);
    if (!user || user.consent?.sharing !== true) throw Object.assign(new Error('该主页未公开或不存在'), { statusCode: 404 });
    const routes = listRoutes().filter(route => data.routes.find(item => item.id === route.id)?.authorId === user.id);
    return { display_name: user.displayName, username: user.username, routes,
      stats: { published_routes: routes.length, likes_received: routes.reduce((sum, route) => sum + route.likes, 0), favorites_received: routes.reduce((sum, route) => sum + route.favorites, 0) } };
  }
  return Object.freeze({ listRoutes, listForModeration, moderateRoute, deleteUserData, popularPois, publishRoute, setMembership, toggleLike, seedSummary, setSeedMembership, checkin, recordView, me, publicProfile, routeSummary });
}

module.exports = { createCommunity, ROUTE_TAGS };
