/**
 * Lsky Lite — EdgeOne Pages 轻量图床
 * 基于 EdgeOne Blob 存储，无需额外数据库
 *
 * 部署路径: cloud-functions/api/lsky.js
 * 访问地址: https://comment.asterias.top/api/lsky
 */

import { getStore } from '@edgeone/pages-blob'
import { v4 as uuidv4 } from 'uuid'

const MAX_SIZE = 10 * 1024 * 1024 // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml']
const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg']

const store = getStore({ name: 'lsky', consistency: 'eventual' })

// ==================== 工具函数 ====================

function extFromType (mime) {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/svg+xml': '.svg'
  }
  return map[mime] || '.bin'
}

function corsHeaders (origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  }
}

// ==================== Blob 存储层 ====================

async function getMetaList () {
  return await store.get('meta:all', { type: 'json' }) || []
}

async function saveMetaList (list) {
  await store.setJSON('meta:all', list)
}

async function addImage (id, buffer, meta) {
  // 存图片数据
  await store.setJSON(`img:${id}`, { data: Array.from(new Uint8Array(buffer)), type: meta.type })
  // 更新元数据列表
  const list = await getMetaList()
  list.unshift(meta)
  await saveMetaList(list)
}

async function getImage (id) {
  const img = await store.get(`img:${id}`, { type: 'json' })
  if (!img) return null
  return { data: new Uint8Array(img.data), type: img.type }
}

async function deleteImage (id) {
  await store.delete(`img:${id}`)
  const list = await getMetaList()
  const idx = list.findIndex(m => m.id === id)
  if (idx !== -1) {
    list.splice(idx, 1)
    await saveMetaList(list)
  }
}

// ==================== 处理函数 ====================

async function handleUpload (request) {
  const ct = request.headers.get('content-type') || ''

  let buffer, fileName, fileType

  if (ct.includes('multipart/form-data')) {
    // 解析 multipart（支持 image 或 file 字段名）
    const form = await request.formData()
    const file = form.get('image') || form.get('file')
    if (!file) return new Response(JSON.stringify({ error: '未提供文件' }), { status: 400, headers: corsHeaders() })
    buffer = await file.arrayBuffer()
    fileName = file.name
    fileType = file.type
  } else if (ct.includes('application/json')) {
    const body = await request.json()
    if (!body.image) return new Response(JSON.stringify({ error: '未提供文件' }), { status: 400, headers: corsHeaders() })
    const raw = atob(body.image.split(',')[1] || body.image)
    buffer = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) buffer[i] = raw.charCodeAt(i)
    fileName = body.name || 'image.png'
    fileType = body.type || 'image/png'
  } else {
    return new Response(JSON.stringify({ error: '不支持的 Content-Type' }), { status: 400, headers: corsHeaders() })
  }

  // 校验
  if (buffer.byteLength > MAX_SIZE) {
    return new Response(JSON.stringify({ error: `文件过大，最大 ${MAX_SIZE / 1024 / 1024}MB` }), { status: 413, headers: corsHeaders() })
  }
  if (!ALLOWED_TYPES.includes(fileType)) {
    return new Response(JSON.stringify({ error: `不支持的文件类型: ${fileType}` }), { status: 415, headers: corsHeaders() })
  }

  const id = uuidv4().replace(/-/g, '')
  const ext = extFromType(fileType)
  const now = Date.now()

  const meta = {
    id,
    name: fileName,
    ext,
    type: fileType,
    size: buffer.byteLength,
    created: now,
    updated: now
  }

  await addImage(id, buffer, meta)

  const url = `/api/lsky/image/${id}${ext}`

  return new Response(JSON.stringify({
    success: true,
    id,
    url,
    name: fileName,
    size: buffer.byteLength
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  })
}

/**
 * Lsky Pro v2 兼容上传端点
 * Twikoo 调用路径: POST {IMAGE_CDN_URL}/api/v1/upload
 * 期望响应: { status: true, data: { links: { url } } }
 */
async function handleLskyProUpload (request, origin) {
  const ct = request.headers.get('content-type') || ''
  if (!ct.includes('multipart/form-data')) {
    return new Response(JSON.stringify({ status: false, message: '仅支持 multipart/form-data' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    })
  }

  const form = await request.formData()
  const file = form.get('file')
  if (!file) {
    return new Response(JSON.stringify({ status: false, message: '未提供文件 (field: file)' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    })
  }

  const buffer = await file.arrayBuffer()
  const fileName = file.name
  const fileType = file.type

  if (buffer.byteLength > MAX_SIZE) {
    return new Response(JSON.stringify({ status: false, message: `文件过大，最大 ${MAX_SIZE / 1024 / 1024}MB` }), {
      status: 413, headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    })
  }
  if (!ALLOWED_TYPES.includes(fileType)) {
    return new Response(JSON.stringify({ status: false, message: `不支持的文件类型: ${fileType}` }), {
      status: 415, headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    })
  }

  const id = uuidv4().replace(/-/g, '')
  const ext = extFromType(fileType)
  const now = Date.now()
  const imageUrl = `${origin}/api/lsky/image/${id}${ext}`

  const meta = {
    id, name: fileName, ext, type: fileType,
    size: buffer.byteLength, created: now, updated: now
  }
  await addImage(id, buffer, meta)

  // Lsky Pro v2 响应格式
  return new Response(JSON.stringify({
    status: true,
    data: {
      links: { url: imageUrl }
    }
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  })
}

async function handleServe (request, url) {
  const path = url.pathname.replace('/api/lsky/image/', '')
  const id = path.split('.')[0] // 去掉扩展名
  if (!id) return new Response('Not Found', { status: 404, headers: corsHeaders() })

  const img = await getImage(id)
  if (!img) return new Response('Image Not Found', { status: 404, headers: corsHeaders() })

  return new Response(img.data, {
    status: 200,
    headers: {
      'Content-Type': img.type,
      'Cache-Control': 'public, max-age=31536000, immutable',
      ...corsHeaders()
    }
  })
}

async function handleList () {
  const list = await getMetaList()
  return new Response(JSON.stringify({ success: true, total: list.length, images: list }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  })
}

async function handleDelete (url) {
  const path = url.pathname.replace('/api/lsky/delete/', '')
  const id = path.split('.')[0]
  if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400, headers: corsHeaders() })

  await deleteImage(id)
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  })
}

async function handleFrontend (request, url) {
  const origin = url.origin
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Lsky Lite - 图床</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f1a; color: #e0e0e0; min-height: 100vh; }
.container { max-width: 960px; margin: 0 auto; padding: 20px; }
h1 { text-align: center; font-size: 24px; margin: 20px 0; color: #7c5cfc; }
/* Upload Zone */
.upload-zone { border: 2px dashed #3a3a5c; border-radius: 12px; padding: 40px; text-align: center; cursor: pointer; transition: all .3s; background: #1a1a2e; margin-bottom: 24px; }
.upload-zone:hover, .upload-zone.dragover { border-color: #7c5cfc; background: #222240; }
.upload-zone p { font-size: 14px; color: #888; margin-top: 8px; }
.upload-zone .icon { font-size: 40px; margin-bottom: 8px; }
input[type="file"] { display: none; }
/* Gallery */
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.card { background: #1a1a2e; border-radius: 8px; overflow: hidden; position: relative; border: 1px solid #2a2a4a; transition: transform .2s; }
.card:hover { transform: translateY(-2px); border-color: #7c5cfc; }
.card img { width: 100%; height: 160px; object-fit: cover; display: block; background: #0a0a15; }
.card .info { padding: 8px 10px; font-size: 12px; }
.card .info .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #aaa; margin-bottom: 4px; }
.card .info .size { color: #666; }
.card .actions { position: absolute; top: 6px; right: 6px; display: flex; gap: 4px; opacity: 0; transition: opacity .2s; }
.card:hover .actions { opacity: 1; }
.card .actions button { background: rgba(0,0,0,.7); border: none; color: #fff; width: 28px; height: 28px; border-radius: 6px; cursor: pointer; font-size: 14px; }
.card .actions .copy-btn:hover { background: #7c5cfc; }
.card .actions .del-btn:hover { background: #e74c3c; }
.toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #7c5cfc; color: #fff; padding: 10px 24px; border-radius: 8px; font-size: 14px; opacity: 0; transition: opacity .3s; pointer-events: none; }
.toast.show { opacity: 1; }
.empty { text-align: center; padding: 60px 20px; color: #555; }
.empty .icon { font-size: 48px; margin-bottom: 12px; }
.counter { text-align: center; font-size: 13px; color: #666; margin-bottom: 16px; }
.progress { display: none; text-align: center; padding: 12px; color: #7c5cfc; font-size: 14px; }
@media (max-width: 600px) { .gallery { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); } }
</style>
</head>
<body>
<div class="container">
  <h1>🖼 Lsky Lite</h1>
  <div class="upload-zone" id="dropZone">
    <div class="icon">📁</div>
    <p>拖拽图片到此处 或 点击选择</p>
    <input type="file" id="fileInput" accept="image/*" multiple>
  </div>
  <div class="progress" id="progress"></div>
  <div class="counter" id="counter"></div>
  <div class="gallery" id="gallery"></div>
  <div class="empty" id="empty">
    <div class="icon">📸</div>
    <p>暂无图片</p>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
const BASE = window.location.pathname.replace(/\\/+$/, '')
let allImages = []
const $ = s => document.querySelector(s)
const $$ = s => document.querySelectorAll(s)

function toast (msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500) }

function formatSize (b) { if (b < 1024) return b + 'B'; if (b < 1048576) return (b/1024).toFixed(1) + 'KB'; return (b/1048576).toFixed(1) + 'MB' }

async function loadList () {
  try {
    const r = await fetch(BASE + '/list')
    const d = await r.json()
    allImages = d.images || []
    render()
  } catch { /* ignore */ }
}

function render () {
  const g = $('#gallery')
  const e = $('#empty')
  const c = $('#counter')
  if (!allImages.length) { g.innerHTML = ''; e.style.display = 'block'; c.textContent = ''; return }
  e.style.display = 'none'
  c.textContent = '共 ' + allImages.length + ' 张图片'
  g.innerHTML = allImages.map(img => \`
    <div class="card">
      <img src="\${BASE}/image/\${img.id}\${img.ext}" alt="\${img.name}" loading="lazy">
      <div class="info">
        <div class="name" title="\${img.name}">\${img.name}</div>
        <div class="size">\${formatSize(img.size)}</div>
      </div>
      <div class="actions">
        <button class="copy-btn" onclick="copyUrl('\${img.id}\${img.ext}')" title="复制URL">🔗</button>
        <button class="del-btn" onclick="delImg('\${img.id}')" title="删除">🗑</button>
      </div>
    </div>
  \`).join('')
}

function copyUrl (path) {
  const url = window.location.origin + BASE + '/image/' + path
  navigator.clipboard.writeText(url).then(() => toast('已复制: ' + url))
}

async function delImg (id) {
  if (!confirm('确定删除？')) return
  try {
    const r = await fetch(BASE + '/delete/' + id, { method: 'DELETE' })
    const d = await r.json()
    if (d.success) { toast('已删除'); loadList() }
    else toast('删除失败')
  } catch { toast('删除失败') }
}

async function uploadFiles (files) {
  const p = $('#progress')
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue
    p.style.display = 'block'; p.textContent = '上传: ' + file.name
    const fd = new FormData()
    fd.append('image', file)
    try {
      const r = await fetch(BASE + '/upload', { method: 'POST', body: fd })
      const d = await r.json()
      if (d.success) toast('上传成功: ' + d.name)
      else toast('失败: ' + (d.error || '未知'))
    } catch { toast('上传失败') }
  }
  p.style.display = 'none'
  loadList()
}

// Events
const dz = $('#dropZone')
const fi = $('#fileInput')
dz.addEventListener('click', () => fi.click())
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover') })
dz.addEventListener('dragleave', () => dz.classList.remove('dragover'))
dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('dragover'); uploadFiles(e.dataTransfer.files) })
fi.addEventListener('change', () => { uploadFiles(fi.files); fi.value = '' })

loadList()
</script>
</body>
</html>`
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders() }
  })
}

// ==================== 入口 ====================

export async function handleLskyRequest (context) {
  const { request } = context
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '')

  // 保存 ORIGIN 供 Lsky Pro 兼容接口使用
  const ORIGIN = url.origin

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('origin')) })
  }

  try {
    // Lsky Pro v2 兼容上传端点 (Twikoo 调用)
    if (path === '/api/v1/upload' || path === '/api/v1/upload/') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: corsHeaders() })
      return handleLskyProUpload(request, ORIGIN)
    }
    // Lsky Lite 路由
    if (path === '/api/lsky' || path === '/api/lsky/') {
      return handleFrontend(request, url)
    }
    if (path.startsWith('/api/lsky/upload')) {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: corsHeaders() })
      return handleUpload(request)
    }
    if (path.startsWith('/api/lsky/image/')) {
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: corsHeaders() })
      return handleServe(request, url)
    }
    if (path === '/api/lsky/list' || path === '/api/lsky/list/') {
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: corsHeaders() })
      return handleList()
    }
    if (path.startsWith('/api/lsky/delete/')) {
      if (request.method !== 'DELETE') return new Response('Method Not Allowed', { status: 405, headers: corsHeaders() })
      return handleDelete(url)
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders() })
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    })
  }
}
