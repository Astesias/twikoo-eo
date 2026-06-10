/**
 * Lsky Lite — EdgeOne Pages 轻量图床
 * 路由入口，EdgeOne 自动映射 /api/lsky/* → 此文件
 * 实际逻辑在 index.js 中处理
 */
export { handleLskyRequest as onRequest } from '../index.js'
