/*!
 * Twikoo EdgeOne Pages Node Function
 * (c) 2020-present iMaeGoo
 * Released under the MIT License.
 *
 * 使用 twikoo-func 实现核心逻辑，通过 Cloud Function 操作 Blob 数据库
 */

import { getStore } from '@edgeone/pages-blob'
import { Resend } from 'resend'
import { v4 as uuidv4 } from 'uuid'
import xss from 'xss'
import bowser from 'bowser'
import {
  getMd5,
  getSha256,
  getXml2js,
  setCustomLibs
} from 'twikoo-func/utils/lib'
import { getIpRegion } from './ip2region-searcher.js'
import {
  getFuncVersion,
  getUrlQuery,
  getUrlsQuery,
  normalizeMail,
  equalsMail,
  getMailMd5,
  getAvatar,
  isQQ,
  addQQMailSuffix,
  getQQNick,
  getQQAvatar,
  getPasswordStatus,
  preCheckSpam,
  checkTurnstileCaptcha,
  checkGeeTestCaptcha,
  checkCapCaptcha,
  getConfig,
  getConfigForAdmin,
  validate,
  checkCommentOwnership
} from 'twikoo-func/utils'
import {
  jsonParse,
  commentImportValine,
  commentImportDisqus,
  commentImportArtalk,
  commentImportArtalk2,
  commentImportTwikoo
} from 'twikoo-func/utils/import'
import { postCheckSpam } from 'twikoo-func/utils/spam'
import { sendNotice, emailTest } from 'twikoo-func/utils/notify'
import { uploadImage } from 'twikoo-func/utils/image'
import logger from 'twikoo-func/utils/logger'
import constants from 'twikoo-func/utils/constants'

const { RES_CODE, MAX_REQUEST_TIMES } = constants
const VERSION = '1.7.11'

// 注入自定义依赖（对标 Cloudflare 版本）
setCustomLibs({
  DOMPurify: {
    sanitize (input) {
      return input
    }
  },
  nodemailer: {
    createTransport (mailConfig) {
      return {
        verify () {
          if (!mailConfig.service || (mailConfig.service.toLowerCase() !== 'sendgrid' && mailConfig.service.toLowerCase() !== 'mailchannels')) {
            throw new Error('仅支持 SendGrid 和 MailChannels 邮件服务。')
          }
          if (!mailConfig.auth || !mailConfig.auth.user) {
            throw new Error('需要在 SMTP_USER 中配置账户名，如果邮件服务不需要可随意填写。')
          }
          if (!mailConfig.auth || !mailConfig.auth.pass) {
            throw new Error('需要在 SMTP_PASS 中配置 API 令牌。')
          }
          return true
        },
        sendMail ({ from, to, subject, html }) {
          if (mailConfig.service.toLowerCase() === 'sendgrid') {
            return fetch('https://api.sendgrid.com/v3/mail/send', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${mailConfig.auth.pass}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                personalizations: [{ to: [{ email: to }] }],
                from: { email: from },
                subject,
                content: [{ type: 'text/html', value: html }]
              })
            })
          } else if (mailConfig.service.toLowerCase() === 'mailchannels') {
            return fetch('https://api.mailchannels.net/tx/v1/send', {
              method: 'POST',
              headers: {
                'X-Api-Key': mailConfig.auth.pass,
                Accept: 'application/json',
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                personalizations: [{ to: [{ email: to }] }],
                from: { email: from },
                subject,
                content: [{ type: 'text/html', value: html }]
              })
            })
          }
        }
      }
    }
  }
})

const md5 = getMd5()
const sha256 = getSha256()
const xml2js = getXml2js()

// ==================== 本地实现的 parseComment（替代 twikoo-func 版本）====================

/**
 * 修复 OS 版本名称
 */
function fixOS (ua) {
  const os = ua.getOS()
  if (!os.versionName) {
    if (os.name === 'Windows' && os.version === 'NT 11.0') {
      os.versionName = '11'
    } else if (os.name === 'macOS') {
      const majorPlatformVersion = os.version?.split('.')[0]
      os.versionName = {
        11: 'Big Sur', 12: 'Monterey', 13: 'Ventura', 14: 'Sonoma', 15: 'Sequoia'
      }[majorPlatformVersion]
    } else if (os.name === 'Android') {
      const majorPlatformVersion = os.version?.split('.')[0]
      os.versionName = {
        10: 'Quince Tart',
        11: 'Red Velvet Cake',
        12: 'Snow Cone',
        13: 'Tiramisu',
        14: 'Upside Down Cake',
        15: 'Vanilla Ice Cream',
        16: 'Baklava'
      }[majorPlatformVersion]
    } else if (ua.test(/harmony/i)) {
      os.name = 'Harmony'
      const match = ua.getUA().match(/harmony[\s/-](\d+(\.\d+)*)/i)
      os.version = (match && match[1]) || ''
      os.versionName = ''
    }
  }
  return os
}

/**
 * 获取回复人昵称
 */
function getRuser (pid, comments = []) {
  const comment = comments.find((item) => item._id === pid)
  return comment ? comment.nick : null
}

/**
 * 将评论记录转换为前端需要的格式（使用本地 IP 归属地查询）
 */
function toCommentDto (comment, uid, replies = [], comments = [], cfg) {
  let displayOs = ''
  let displayBrowser = ''
  if (cfg.SHOW_UA !== 'false') {
    try {
      const ua = bowser.getParser(comment.ua)
      const os = fixOS(ua)
      displayOs = [os.name, os.versionName ? os.versionName : os.version].join(' ')
      displayBrowser = [ua.getBrowserName(), ua.getBrowserVersion()].join(' ')
    } catch (e) {
      logger.warn('bowser 错误：', e)
    }
  }
  const showRegion = !!cfg.SHOW_REGION && cfg.SHOW_REGION !== 'false'
  return {
    id: comment._id.toString(),
    nick: comment.nick,
    avatar: comment.avatar,
    mailMd5: getMailMd5(comment),
    link: comment.link,
    comment: comment.comment,
    os: displayOs,
    browser: displayBrowser,
    ipRegion: showRegion ? getIpRegion(comment.ip, false) : '',
    master: comment.master,
    like: comment.like ? comment.like.length : 0,
    liked: comment.like ? comment.like.findIndex((item) => item === uid) > -1 : false,
    replies: replies,
    rid: comment.rid,
    pid: comment.pid,
    ruser: getRuser(comment.pid, comments),
    top: comment.top,
    isSpam: comment.isSpam,
    created: comment.created,
    updated: comment.updated
  }
}

/**
 * 筛除隐私字段，拼接回复列表（本地实现，使用自己的 IP 归属地查询）
 */
function parseComment (comments, uid, cfg) {
  const result = []
  for (const comment of comments) {
    if (!comment.rid) {
      const replies = comments
        .filter((item) => item.rid === comment._id.toString())
        .map((item) => toCommentDto(item, uid, [], comments, cfg))
        .sort((a, b) => a.created - b.created)
      result.push(toCommentDto(comment, uid, replies, [], cfg))
    }
  }
  return result
}

/**
 * 为管理后台解析评论
 */
function parseCommentForAdmin (comments) {
  for (const comment of comments) {
    comment.ipRegion = getIpRegion(comment.ip, true)
  }
  return comments
}

// 全局变量
let config = null
const requestTimes = {}

// ==================== 工具函数 ====================

// eslint-disable-next-line no-unused-vars
function getAllowedOrigin (req) {
  const origin = req.headers.origin
  const localhostRegex = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d{1,5})?$/
  if (localhostRegex.test(origin)) {
    return origin
  } else if (config && config.CORS_ALLOW_ORIGIN) {
    const corsList = config.CORS_ALLOW_ORIGIN.split(',')
    for (const cors of corsList) {
      if (cors.replace(/\/$/, '') === origin) {
        return origin
      }
    }
    return ''
  }
  return origin
}

// 获取 IP（优先使用 EdgeOne 提供的 eo-connecting-ip）
function getIp (req) {
  return req.headers['eo-connecting-ip'] ||
         req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] ||
         req.ip ||
         'unknown'
}

function protect (ip) {
  requestTimes[ip] = (requestTimes[ip] || 0) + 1
  if (requestTimes[ip] > MAX_REQUEST_TIMES) {
    logger.warn(`${ip} 当前请求次数为 ${requestTimes[ip]}，已超过最大请求次数`)
    throw new Error('Too Many Requests')
  }
  logger.log(`${ip} 当前请求次数为 ${requestTimes[ip]}`)
}

// 定期清理请求计数
setInterval(() => {
  Object.keys(requestTimes).forEach(key => delete requestTimes[key])
}, 10 * 60 * 1000)

// ==================== 评论过滤函数（原本在 KV 内，移除 KV 后迁移到 Blob 数据库层） ====================

function filterComments (comments, query) {
  if (!Object.keys(query).length) return comments
  return comments.filter(comment => {
    for (const [key, value] of Object.entries(query)) {
      if (key === '$or') {
        const orMatch = value.some(cond =>
          Object.entries(cond).every(([k, v]) => matchCondition(comment, k, v))
        )
        if (!orMatch) return false
      } else if (!matchCondition(comment, key, value)) {
        return false
      }
    }
    return true
  })
}

function matchCondition (comment, key, value) {
  const cv = comment[key]
  if (value === null || value === undefined) return cv === null || cv === undefined
  if (typeof value === 'object') {
    if ('$in' in value) return value.$in.includes(cv)
    if ('$ne' in value) return cv !== value.$ne
    if ('$exists' in value) return value.$exists
      ? (cv !== undefined && cv !== null && cv !== '')
      : (cv === undefined || cv === null || cv === '')
    if ('$gt' in value) return cv > value.$gt
    if ('$lt' in value) return cv < value.$lt
    if ('$regex' in value) return new RegExp(value.$regex, value.$options || '').test(cv)
  }
  return cv === value
}

// ==================== Blob 数据库层 ====================

const COMMENTS_KEY = 'comments:all'

function createBlobDatabase () {
  const store = getStore({ name: 'twikoo', consistency: 'eventual' })
  let commentsCache = null

  return {
    async getAllComments () {
      if (commentsCache !== null) return commentsCache
      commentsCache = await store.get(COMMENTS_KEY, { type: 'json' }) ?? []
      return commentsCache
    },
    async saveAllComments (comments) {
      commentsCache = comments
      await store.setJSON(COMMENTS_KEY, comments)
    },
    async getComments (query = {}) {
      const all = await this.getAllComments()
      return filterComments(all, query)
    },
    async countComments (query = {}) {
      return (await this.getComments(query)).length
    },
    async addComment (comment) {
      const id = comment._id || uuidv4().replace(/-/g, '')
      comment._id = id
      comment.id = id
      const comments = await this.getAllComments()
      comments.push(comment)
      await this.saveAllComments(comments)
      return { id }
    },
    async updateComment (id, updates) {
      const comments = await this.getAllComments()
      const index = comments.findIndex(c => c._id === id)
      if (index !== -1) {
        Object.assign(comments[index], updates)
        await this.saveAllComments(comments)
        return { updated: 1 }
      }
      return { updated: 0 }
    },
    async deleteComment (id) {
      const comments = await this.getAllComments()
      const index = comments.findIndex(c => c._id === id)
      if (index !== -1) {
        comments.splice(index, 1)
        await this.saveAllComments(comments)
        return { deleted: 1 }
      }
      return { deleted: 0 }
    },
    async getComment (id) {
      const comments = await this.getAllComments()
      return comments.find(c => c._id === id) || null
    },
    async bulkAddComments (newComments) {
      const comments = await this.getAllComments()
      for (const comment of newComments) {
        const id = comment._id || uuidv4().replace(/-/g, '')
        comment._id = id
        comment.id = id
        comments.push(comment)
      }
      await this.saveAllComments(comments)
      return newComments.length
    },
    async getConfig () {
      return await store.get('config:main', { type: 'json' }) ?? {}
    },
    async saveConfig (newConfig) {
      const current = await this.getConfig()
      await store.setJSON('config:main', { ...current, ...newConfig })
      return { updated: 1 }
    },
    async getCounter (url) {
      return await store.get(`counter:${encodeURIComponent(url)}`, { type: 'json' })
    },
    async incCounter (url, title) {
      const key = `counter:${encodeURIComponent(url)}`
      let counter = await store.get(key, { type: 'json' })
      if (counter) {
        counter.time = (counter.time || 0) + 1
        counter.title = title
        counter.updated = Date.now()
      } else {
        counter = { url, title, time: 1, created: Date.now(), updated: Date.now() }
      }
      await store.setJSON(key, counter)
      return 1
    }
  }
}

// ==================== 配置管理 ====================

async function readConfig () {
  try {
    const db = createBlobDatabase()
    config = await db.getConfig()
  } catch (e) {
    logger.error('读取配置失败:', e.message)
    config = {}
  }
  return config
}

async function writeConfig (db, newConfig) {
  if (!Object.keys(newConfig).length) return 0
  logger.info('写入配置')
  await db.saveConfig(newConfig)
  config = null
  return 1
}

function isAdmin (accessToken) {
  return config && config.ADMIN_PASS === md5(accessToken)
}

// ==================== 密码管理 ====================

async function setPassword (event, db, accessToken) {
  const isAdminUser = isAdmin(accessToken)
  if (config.ADMIN_PASS && !isAdminUser) {
    return { code: RES_CODE.PASS_EXIST, message: '请先登录再修改密码' }
  }
  const ADMIN_PASS = md5(event.password)
  await writeConfig(db, { ADMIN_PASS })
  return { code: RES_CODE.SUCCESS }
}

async function login (password) {
  if (!config) {
    return { code: RES_CODE.CONFIG_NOT_EXIST, message: '数据库无配置' }
  }
  if (!config.ADMIN_PASS) {
    return { code: RES_CODE.PASS_NOT_EXIST, message: '未配置管理密码' }
  }
  if (config.ADMIN_PASS !== md5(password)) {
    return { code: RES_CODE.PASS_NOT_MATCH, message: '密码错误' }
  }
  return { code: RES_CODE.SUCCESS }
}

// ==================== 评论读取 ====================

async function commentGet (event, db, accessToken) {
  const res = {}
  try {
    validate(event, ['url'])
    const uid = accessToken
    const isAdminUser = isAdmin(accessToken)
    const limit = parseInt(config.COMMENT_PAGE_SIZE) || 8
    const sort = event.sort || 'newest'
    let more = false

    const urlQuery = getUrlQuery(event.url)

    // 获取所有评论
    const allComments = await db.getComments()

    // 过滤主楼评论
    let mainComments = allComments.filter(c =>
      urlQuery.includes(c.url) &&
      (!c.rid || c.rid === '') &&
      (c.isSpam !== true || c.uid === uid || isAdminUser)
    )

    // 计算总数
    const count = mainComments.length

    // 排序
    if (sort === 'oldest') {
      mainComments.sort((a, b) => a.created - b.created)
    } else if (sort === 'popular') {
      mainComments.sort((a, b) => {
        const aUps = a.ups ? a.ups.length : 0
        const bUps = b.ups ? b.ups.length : 0
        if (bUps !== aUps) return bUps - aUps
        return b.created - a.created
      })
    } else {
      mainComments.sort((a, b) => b.created - a.created)
    }

    // 处理置顶和分页
    let top = []
    if (!config.TOP_DISABLED && !event.before) {
      top = mainComments.filter(c => c.top === true)
      mainComments = mainComments.filter(c => c.top !== true)
    }

    // 分页
    if (event.before) {
      mainComments = mainComments.filter(c => c.created < event.before)
    }

    if (mainComments.length > limit) {
      more = true
      mainComments = mainComments.slice(0, limit)
    }

    // 合并置顶
    mainComments = [...top, ...mainComments]

    // 获取回复
    const mainIds = mainComments.map(c => c._id)
    const replies = allComments.filter(c =>
      mainIds.includes(c.rid) &&
      (c.isSpam !== true || c.uid === uid || isAdminUser)
    )

    res.data = parseComment([...mainComments, ...replies], uid, config)
    res.more = more
    res.count = count
  } catch (e) {
    res.data = []
    res.message = e.message
  }
  return res
}

// ==================== 管理员评论操作 ====================

async function commentGetForAdmin (event, db, accessToken) {
  const res = {}
  const isAdminUser = isAdmin(accessToken)
  if (isAdminUser) {
    validate(event, ['per', 'page'])

    let comments = await db.getComments()

    if (event.type === 'VISIBLE') {
      comments = comments.filter(c => c.isSpam !== true)
    } else if (event.type === 'HIDDEN') {
      comments = comments.filter(c => c.isSpam === true)
    }

    if (event.keyword) {
      const keyword = event.keyword.toLowerCase()
      comments = comments.filter(c =>
        (c.nick && c.nick.toLowerCase().includes(keyword)) ||
        (c.mail && c.mail.toLowerCase().includes(keyword)) ||
        (c.link && c.link.toLowerCase().includes(keyword)) ||
        (c.ip && c.ip.toLowerCase().includes(keyword)) ||
        (c.comment && c.comment.toLowerCase().includes(keyword)) ||
        (c.url && c.url.toLowerCase().includes(keyword)) ||
        (c.href && c.href.toLowerCase().includes(keyword))
      )
    }

    comments.sort((a, b) => b.created - a.created)

    const count = comments.length
    const start = event.per * (event.page - 1)
    const data = comments.slice(start, start + event.per)

    res.code = RES_CODE.SUCCESS
    res.count = count
    res.data = parseCommentForAdmin(data)
  } else {
    res.code = RES_CODE.NEED_LOGIN
    res.message = '请先登录'
  }
  return res
}

async function commentSetForAdmin (event, db, accessToken) {
  const res = {}
  const isAdminUser = isAdmin(accessToken)
  if (isAdminUser) {
    validate(event, ['id', 'set'])
    await db.updateComment(event.id, {
      ...event.set,
      updated: Date.now()
    })
    res.code = RES_CODE.SUCCESS
    res.updated = 1
  } else {
    res.code = RES_CODE.NEED_LOGIN
    res.message = '请先登录'
  }
  return res
}

async function commentDeleteForAdmin (event, db, accessToken) {
  const res = {}
  const isAdminUser = isAdmin(accessToken)
  if (isAdminUser) {
    validate(event, ['id'])
    await db.deleteComment(event.id)
    res.code = RES_CODE.SUCCESS
    res.deleted = 1
  } else {
    res.code = RES_CODE.NEED_LOGIN
    res.message = '请先登录'
  }
  return res
}

// 用户删除自己的评论
async function commentDeleteForUser (event, db, accessToken) {
  const res = {}
  try {
    const uid = accessToken
    await checkCommentOwnership(event.id, uid, async (id) => {
      return db.getComment(id)
    })
    await db.deleteComment(event.id)
    res.code = RES_CODE.SUCCESS
    res.deleted = 1
  } catch (e) {
    res.code = RES_CODE.FAIL
    res.message = e.message
  }
  return res
}

async function commentImportForAdmin (event, db, accessToken) {
  const res = {}
  let logText = ''
  const log = (message) => {
    logText += `${new Date().toLocaleString()} ${message}\n`
  }
  const isAdminUser = isAdmin(accessToken)
  if (isAdminUser) {
    try {
      validate(event, ['source', 'file'])
      log(`开始导入 ${event.source}`)
      let comments
      switch (event.source) {
        case 'valine': {
          const valineDb = await readFile(event.file, 'json', log)
          comments = await commentImportValine(valineDb, log)
          break
        }
        case 'disqus': {
          const disqusDb = await readFile(event.file, 'xml', log)
          comments = await commentImportDisqus(disqusDb, log)
          break
        }
        case 'artalk': {
          const artalkDb = await readFile(event.file, 'json', log)
          comments = await commentImportArtalk(artalkDb, log)
          break
        }
        case 'artalk2': {
          const artalkDb = await readFile(event.file, 'json', log)
          comments = await commentImportArtalk2(artalkDb, log)
          break
        }
        case 'twikoo': {
          const twikooDb = await readFile(event.file, 'json', log)
          comments = await commentImportTwikoo(twikooDb, log)
          break
        }
        default:
          throw new Error(`不支持 ${event.source} 的导入，请更新 Twikoo 云函数至最新版本`)
      }
      await db.bulkAddComments(comments)
      log('导入成功')
    } catch (e) {
      log(e.message)
    }
    res.code = RES_CODE.SUCCESS
    res.log = logText
    logger.info(logText)
  } else {
    res.code = RES_CODE.NEED_LOGIN
    res.message = '请先登录'
  }
  return res
}

async function commentExportForAdmin (event, db, accessToken) {
  const res = {}
  const isAdminUser = isAdmin(accessToken)
  if (isAdminUser) {
    const data = await db.getComments()
    res.code = RES_CODE.SUCCESS
    res.data = data
  } else {
    res.code = RES_CODE.NEED_LOGIN
    res.message = '请先登录'
  }
  return res
}

async function readFile (file, type, log) {
  try {
    let content = file.toString('utf8')
    log('评论文件读取成功')
    if (type === 'json') {
      content = jsonParse(content)
      log('评论文件 JSON 解析成功')
    } else if (type === 'xml') {
      content = await xml2js.parseStringPromise(content)
      log('评论文件 XML 解析成功')
    }
    return content
  } catch (e) {
    log(`评论文件读取失败：${e.message}`)
  }
}

// ==================== 点赞 ====================

async function commentLike (event, db, accessToken) {
  const res = {}
  validate(event, ['id'])
  const uid = accessToken
  const type = event.type || 'up'
  const comment = await db.getComment(event.id)

  if (comment) {
    const ups = comment.ups || []
    const downs = comment.downs || []

    let newUps = [...ups]
    let newDowns = [...downs]

    if (type === 'up') {
      const index = ups.indexOf(uid)
      if (index === -1) {
        newUps.push(uid)
        newDowns = newDowns.filter((item) => item !== uid)
      } else {
        newUps.splice(index, 1)
      }
    } else if (type === 'down') {
      const index = downs.indexOf(uid)
      if (index === -1) {
        newDowns.push(uid)
        newUps = newUps.filter((item) => item !== uid)
      } else {
        newDowns.splice(index, 1)
      }
    }

    await db.updateComment(event.id, { ups: newUps, downs: newDowns })
    res.updated = 1
  } else {
    res.updated = 0
  }
  return res
}

// ==================== 评论提交 ====================

async function commentSubmit (event, req, db, accessToken) {
  const res = {}
  validate(event, ['url', 'ua', 'comment'])

  const ip = getIp(req)

  // 限流检查
  await limitFilter(db, ip)

  // 验证码检查
  await checkCaptcha(event, ip)

  // 解析评论数据
  const data = await parseCommentData(event, req, accessToken, ip)

  // 保存评论
  const result = await db.addComment(data)
  data.id = result.id
  data._id = result.id
  res.id = result.id

  // 异步处理垃圾检测和通知
  postSubmit(data, db).catch(e => {
    logger.error('POST_SUBMIT 失败', e.message)
  })

  return res
}

async function parseCommentData (event, req, accessToken, ip) {
  const timestamp = Date.now()
  const isAdminUser = isAdmin(accessToken)
  const isBloggerMail = equalsMail(config.BLOGGER_EMAIL, event.mail)

  if (isBloggerMail && !isAdminUser) {
    throw new Error('请先登录管理面板，再使用博主身份发送评论')
  }

  const hashMethod = config.GRAVATAR_CDN === 'cravatar.cn' ? md5 : sha256

  const commentDo = {
    _id: uuidv4().replace(/-/g, ''),
    uid: accessToken,
    nick: event.nick ? event.nick : '匿名',
    mail: event.mail ? event.mail : '',
    mailMd5: event.mail ? hashMethod(normalizeMail(event.mail)) : '',
    link: event.link ? event.link : '',
    ua: event.ua,
    ip: ip,
    master: isBloggerMail,
    url: event.url,
    href: event.href,
    comment: xss(event.comment),
    pid: event.pid ? event.pid : event.rid,
    rid: event.rid,
    isSpam: isAdminUser ? false : preCheckSpam(event, config),
    created: timestamp,
    updated: timestamp
  }

  // 处理 QQ 邮箱和头像
  if (isQQ(event.mail)) {
    commentDo.mail = addQQMailSuffix(event.mail)
    commentDo.mailMd5 = md5(normalizeMail(commentDo.mail))
    try {
      commentDo.avatar = await getQQAvatar(event.mail)
    } catch (e) {
      logger.warn('获取 QQ 头像失败：', e.message)
    }
  }

  return commentDo
}

async function postSubmit (comment, db) {
  try {
    logger.log('POST_SUBMIT')

    // 获取父评论
    const getParentComment = async (c) => {
      if (c.pid) {
        return db.getComment(c.pid)
      }
      return null
    }

    // 垃圾检测
    const isSpam = await postCheckSpam(comment, config)
    if (isSpam && !comment.isSpam) {
      await db.updateComment(comment._id, { isSpam: true, updated: Date.now() })
      comment.isSpam = isSpam
    }

    // 发送通知
    await sendNotice(comment, config, getParentComment)

    // 发送邮件通知站长
    if (!comment.isSpam) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY)
        const articlePath = comment.url || comment.href || '未知页面'
        const commentText = (comment.comment || '').replace(/<[^>]*>/g, '').substring(0, 200)
        await resend.emails.send({
          from: 'Astesias Blog <onboarding@resend.dev>',
          to: '2264168148@qq.com',
          subject: `[新评论] ${comment.nick || '匿名'} 在 ${articlePath}`,
          html: `<p><strong>${comment.nick || '匿名'}</strong> 评论了文章：</p>
<p>📄 路由：<code>${articlePath}</code></p>
<p>💬 内容：${commentText}${(comment.comment || '').length > 200 ? '...' : ''}</p>
<p><a href="https://asterias.top${articlePath}">查看详情 →</a></p>`,
        })
        logger.log('邮件通知已发送')
      } catch (e) {
        logger.warn('邮件通知发送失败', e.message)
      }
    }
  } catch (e) {
    logger.warn('POST_SUBMIT 失败', e)
  }
}

async function limitFilter (db, ip) {
  let limitPerMinute = parseInt(config.LIMIT_PER_MINUTE)
  if (Number.isNaN(limitPerMinute)) limitPerMinute = 10

  if (limitPerMinute) {
    const comments = await db.getComments()
    const recentComments = comments.filter(c =>
      c.ip === ip && c.created > Date.now() - 600000
    )
    if (recentComments.length > limitPerMinute) {
      throw new Error('发言频率过高')
    }
  }

  let limitPerMinuteAll = parseInt(config.LIMIT_PER_MINUTE_ALL)
  if (Number.isNaN(limitPerMinuteAll)) limitPerMinuteAll = 10

  if (limitPerMinuteAll) {
    const comments = await db.getComments()
    const recentComments = comments.filter(c => c.created > Date.now() - 600000)
    if (recentComments.length > limitPerMinuteAll) {
      throw new Error('评论太火爆啦 >_< 请稍后再试')
    }
  }
}

async function checkCaptcha (event, ip) {
  const provider = config.CAPTCHA_PROVIDER
  if (provider === 'Turnstile' && config.TURNSTILE_SITE_KEY && config.TURNSTILE_SECRET_KEY) {
    await checkTurnstileCaptcha({
      ip: ip,
      turnstileToken: event.turnstileToken,
      turnstileTokenSecretKey: config.TURNSTILE_SECRET_KEY
    })
  } else if (provider === 'Geetest' && config.GEETEST_CAPTCHA_ID && config.GEETEST_CAPTCHA_KEY) {
    await checkGeeTestCaptcha({
      geeTestCaptchaId: config.GEETEST_CAPTCHA_ID,
      geeTestCaptchaKey: config.GEETEST_CAPTCHA_KEY,
      geeTestLotNumber: event.geeTestLotNumber,
      geeTestCaptchaOutput: event.geeTestCaptchaOutput,
      geeTestPassToken: event.geeTestPassToken,
      geeTestGenTime: event.geeTestGenTime
    })
  } else if (provider === 'Cap' && config.CAP_API_ENDPOINT && config.CAP_SECRET_KEY) {
    if (!event.capToken) {
      throw new Error('验证码 token 缺失，请刷新页面重试')
    }
    await checkCapCaptcha({
      capToken: event.capToken,
      capSecretKey: config.CAP_SECRET_KEY,
      capApiEndpoint: config.CAP_API_ENDPOINT
    })
  } else if (provider === 'Cap') {
    throw new Error('Cap 验证码配置不完整，请联系管理员')
  } else if (provider) {
    throw new Error(`不支持的验证码类型: ${provider}`)
  }
}

// ==================== 配置操作 ====================

async function setConfig (event, db, accessToken) {
  const isAdminUser = isAdmin(accessToken)
  if (isAdminUser) {
    await writeConfig(db, event.config)
    return { code: RES_CODE.SUCCESS }
  } else {
    return { code: RES_CODE.NEED_LOGIN, message: '请先登录' }
  }
}

// ==================== 计数器 ====================

async function counterGet (event, db) {
  const res = {}
  try {
    validate(event, ['url'])
    const record = await db.getCounter(event.url)
    res.data = record || {}
    res.time = res.data.time || 0
    res.updated = await db.incCounter(event.url, event.title)
  } catch (e) {
    res.message = e.message
  }
  return res
}

// ==================== 评论统计 ====================

async function getCommentsCount (event, db) {
  const res = {}
  try {
    validate(event, ['urls'])
    const comments = await db.getComments()

    res.data = []
    for (const url of event.urls) {
      const urlVariants = getUrlQuery(url)
      const count = comments.filter(c =>
        urlVariants.includes(c.url) &&
        c.isSpam !== true &&
        (event.includeReply || !c.rid || c.rid === '')
      ).length
      res.data.push({ url, count })
    }
  } catch (e) {
    res.message = e.message
  }
  return res
}

async function getRecentComments (event, db) {
  const res = {}
  try {
    let comments = await db.getComments()

    comments = comments.filter(c => c.isSpam !== true)

    if (event.urls && event.urls.length) {
      const urlsQuery = getUrlsQuery(event.urls)
      comments = comments.filter(c => urlsQuery.includes(c.url))
    }

    if (!event.includeReply) {
      comments = comments.filter(c => !c.rid || c.rid === '')
    }

    comments.sort((a, b) => b.created - a.created)

    const pageSize = Math.min(event.pageSize || 10, 100)
    comments = comments.slice(0, pageSize)

    res.data = comments.map(comment => ({
      id: comment._id,
      url: comment.url,
      nick: comment.nick,
      avatar: getAvatar(comment, config),
      mailMd5: getMailMd5(comment),
      link: comment.link,
      comment: comment.comment,
      commentText: comment.comment.replace(/<[^>]*>/g, ''),
      created: comment.created
    }))
  } catch (e) {
    res.message = e.message
  }
  return res
}

// 资源代理：GET /api/resource?key=xxx → Blob 文件
const MIME_MAP = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
};

async function handleResource(url, res) {
  let key = url.searchParams.get('key');
  if (key === null) { res.status(400).json({ error: 'Missing key' }); return; }
  key = key.replace(/^\/+/, '');  // ← 加这行

  try {
    const store = getStore('resources');

    // 目录列表
    if (url.searchParams.get('list') === '1') {
      const { blobs } = await store.list({ prefix: key });
      const files = blobs.map(b => b.key.replace(key, '')).filter(n => n && !n.includes('/'));
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.json({ files });
      return;
    }

    // 读取文件
    const isBinary = /\.(jpg|jpeg|png|gif|webp|avif|svg|ico|woff2?|ttf|eot|mp4|webm|mp3|pdf|zip)$/i.test(key);
    let body, headers;
    if (isBinary) {
      body = await store.get(key, { type: 'arrayBuffer' });
      if (!body) { res.status(404).json({ error: 'Not Found' }); return; }
      headers = {};
    } else {
      const result = await store.getWithHeaders(key);
      if (!result) { res.status(404).json({ error: 'Not Found' }); return; }
      body = result.body;
      headers = result.headers;
    }

    const ext = (key.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
    const ct = headers['content-type'] || MIME_MAP[ext] || 'application/octet-stream';

    // 缓存策略
    let cache = 'public, max-age=3600';
    if (/\.(js|css|woff2?|ttf|ico|png|jpe?g|gif|webp|avif|svg)$/i.test(key))
      cache = 'public, max-age=31536000, immutable';
    else if (/\.(json|md|txt|xml)$/i.test(key))
      cache = 'public, max-age=60, must-revalidate';

    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', cache);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (headers.etag) res.setHeader('ETag', headers.etag);
    res.send(body);
  } catch (e) {
    console.error('Resource error:', e.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

// Admin API：POST 上传/删除 Blob 文件
async function handleAdmin(request, url, res) {
  const action = url.searchParams.get('action');
  const store = getStore('resources');

  // 登录验证（无需 key）
  if (action === 'login') {
    try {
      const { pwd } = await request.json();
      if (!pwd) { res.json({ ok: false, error: 'Missing password' }); return; }
      const hash = await sha256(pwd);
      const stored = await store.get('config:admin', { type: 'json' });
      if (!stored || !stored.pwdHash) {
        // 首次使用：存储初始密码（用当前传入的哈希）
        await store.setJSON('config:admin', { pwdHash: hash });
        res.json({ ok: true, autoCreated: true });
        return;
      }
      if (hash !== stored.pwdHash) { res.json({ ok: false, error: '密码错误' }); return; }
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
    return;
  }

  const key = url.searchParams.get('key');
  if (key === null) { res.json({ error: 'Missing key' }); return; }

  if (action === 'upload') {
    try {
      const body = await request.arrayBuffer();
      await store.set(key, new Uint8Array(body));
      res.json({ ok: true, key });
    } catch (e) {
      res.json({ error: e.message });
    }
    return;
  }

  if (action === 'delete') {
    try {
      await store.delete(key);
      res.json({ ok: true, key });
    } catch (e) {
      res.json({ error: e.message });
    }
    return;
  }

  if (action === 'list') {
    try {
      const { blobs, directories } = await store.list({ prefix: key, directories: true });
      const files = blobs.map(b => ({ key: b.key, size: 0, etag: b.etag }));
      res.json({ files, directories: directories || [] });
    } catch (e) {
      res.json({ error: e.message });
    }
    return;
  }

  res.json({ error: 'Unknown action' });
}

// ==================== Lsky Lite 图床（内联）====================

const _LSZ = 10 * 1024 * 1024
const _LAT = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml']
const _LS = getStore({ name: 'lsky', consistency: 'eventual' })
function _LE(m) { return ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'image/svg+xml': '.svg' })[m] || '.bin' }
function _LC() { return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } }
async function _LG() { return await _LS.get('meta:all', { type: 'json' }) || [] }
async function _LW(l) { await _LS.setJSON('meta:all', l) }
async function _LA(id, buf, meta) { await _LS.setJSON('img:' + id, { data: Array.from(new Uint8Array(buf)), type: meta.type }); const l = await _LG(); l.unshift(meta); await _LW(l) }
async function _LGI(id) { const i = await _LS.get('img:' + id, { type: 'json' }); return i ? { data: new Uint8Array(i.data), type: i.type } : null }
async function _LD(id) { await _LS.delete('img:' + id); const l = await _LG(); const idx = l.findIndex(m => m.id === id); if (idx !== -1) { l.splice(idx, 1); await _LW(l) } }
async function _LU(req) {
  const ct = req.headers.get('content-type') || ''; let buf, fn, ft
  if (ct.includes('multipart/form-data')) { const f = await req.formData(); const fi = f.get('image') || f.get('file'); if (!fi) return new Response(JSON.stringify({ error: 'no file' }), { status: 400, headers: _LC() }); buf = await fi.arrayBuffer(); fn = fi.name; ft = fi.type }
  else if (ct.includes('application/json')) { const b = await req.json(); if (!b.image) return new Response(JSON.stringify({ error: 'no file' }), { status: 400, headers: _LC() }); const r = atob(b.image.split(',')[1] || b.image); buf = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) buf[i] = r.charCodeAt(i); fn = b.name || 'img'; ft = b.type || 'image/png' }
  else return new Response(JSON.stringify({ error: 'bad ct' }), { status: 400, headers: _LC() })
  if (buf.byteLength > _LSZ) return new Response(JSON.stringify({ error: 'too large' }), { status: 413, headers: _LC() })
  if (!_LAT.includes(ft)) return new Response(JSON.stringify({ error: 'bad type' }), { status: 415, headers: _LC() })
  const id = uuidv4().replace(/-/g, ''); const ex = _LE(ft)
  await _LA(id, buf, { id, name: fn, ext: ex, type: ft, size: buf.byteLength, created: Date.now(), updated: Date.now() })
  return new Response(JSON.stringify({ success: true, id, url: '/?__lsky=image&id=' + id, name: fn, size: buf.byteLength }), { status: 200, headers: { 'Content-Type': 'application/json', ..._LC() } })
}
async function _LPU(req, o) {
  const ct = req.headers.get('content-type') || ''
  if (!ct.includes('multipart/form-data')) return new Response(JSON.stringify({ status: false, message: 'bad' }), { status: 400, headers: { 'Content-Type': 'application/json', ..._LC() } })
  const f = await req.formData(); const fi = f.get('file'); if (!fi) return new Response(JSON.stringify({ status: false, message: 'no file' }), { status: 400, headers: { 'Content-Type': 'application/json', ..._LC() } })
  const buf = await fi.arrayBuffer(); const ft = fi.type
  if (buf.byteLength > _LSZ) return new Response(JSON.stringify({ status: false, message: 'too large' }), { status: 413, headers: { 'Content-Type': 'application/json', ..._LC() } })
  if (!_LAT.includes(ft)) return new Response(JSON.stringify({ status: false, message: 'bad type' }), { status: 415, headers: { 'Content-Type': 'application/json', ..._LC() } })
  const id = uuidv4().replace(/-/g, ''); const ex = _LE(ft)
  await _LA(id, buf, { id, name: fi.name, ext: ex, type: ft, size: buf.byteLength, created: Date.now(), updated: Date.now() })
  return new Response(JSON.stringify({ status: true, data: { links: { url: o + '/api/lsky/image/' + id + ex } } }), { status: 200, headers: { 'Content-Type': 'application/json', ..._LC() } })
}
async function _LSV(u) { const id = u.pathname.replace('/api/lsky/image/', '').split('.')[0]; if (!id) return new Response('NF', { status: 404, headers: _LC() }); const i = await _LGI(id); if (!i) return new Response('NF', { status: 404, headers: _LC() }); return new Response(i.data, { status: 200, headers: { 'Content-Type': i.type, 'Cache-Control': 'public, max-age=31536000, immutable', ..._LC() } }) }
async function _LL() { const l = await _LG(); return new Response(JSON.stringify({ success: true, total: l.length, images: l }), { status: 200, headers: { 'Content-Type': 'application/json', ..._LC() } }) }
async function _LDL(u) { const id = u.pathname.replace('/api/lsky/delete/', '').split('.')[0]; if (!id) return new Response(JSON.stringify({ error: 'no id' }), { status: 400, headers: _LC() }); await _LD(id); return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json', ..._LC() } }) }
function _LF(u) {
  const o = u.origin
  return new Response('<!DOCTYPE html>\n<html lang="zh-CN">\n<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Lsky Lite</title>\n<style>\n*{margin:0;padding:0;box-sizing:border-box}\nbody{font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;background:#0f0f1a;color:#e0e0e0;min-height:100vh}\n.container{max-width:960px;margin:0 auto;padding:20px}\nh1{text-align:center;font-size:24px;margin:20px 0;color:#7c5cfc}\n.upload-zone{border:2px dashed #3a3a5c;border-radius:12px;padding:40px;text-align:center;cursor:pointer;transition:all .3s;background:#1a1a2e;margin-bottom:24px}\n.upload-zone:hover,.upload-zone.dragover{border-color:#7c5cfc;background:#222240}\n.upload-zone p{font-size:14px;color:#888;margin-top:8px}\n.upload-zone .icon{font-size:40px;margin-bottom:8px}\ninput[type="file"]{display:none}\n.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}\n.card{background:#1a1a2e;border-radius:8px;overflow:hidden;position:relative;border:1px solid #2a2a4a;transition:transform .2s}\n.card:hover{transform:translateY(-2px);border-color:#7c5cfc}\n.card img{width:100%;height:160px;object-fit:cover;display:block;background:#0a0a15}\n.card .info{padding:8px 10px;font-size:12px}\n.card .info .name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#aaa;margin-bottom:4px}\n.card .info .size{color:#666}\n.card .actions{position:absolute;top:6px;right:6px;display:flex;gap:4px;opacity:0;transition:opacity .2s}\n.card:hover .actions{opacity:1}\n.card .actions button{background:rgba(0,0,0,.7);border:none;color:#fff;width:28px;height:28px;border-radius:6px;cursor:pointer;font-size:14px}\n.card .actions .copy-btn:hover{background:#7c5cfc}\n.card .actions .del-btn:hover{background:#e74c3c}\n.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#7c5cfc;color:#fff;padding:10px 24px;border-radius:8px;font-size:14px;opacity:0;transition:opacity .3s;pointer-events:none}\n.toast.show{opacity:1}\n.empty{text-align:center;padding:60px 20px;color:#555}\n.empty .icon{font-size:48px;margin-bottom:12px}\n.counter{text-align:center;font-size:13px;color:#666;margin-bottom:16px}\n.progress{display:none;text-align:center;padding:12px;color:#7c5cfc;font-size:14px}\n@media(max-width:600px){.gallery{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}}\n</style></head>\n<body><div class="container">\n<h1>\uD83D\uDDBC Lsky Lite</h1>\n<div class="upload-zone" id="dropZone"><div class="icon">\uD83D\uDCC1</div><p>\u62D6\u62FD\u56FE\u7247\u5230\u6B64\u5904 \u6216 \u70B9\u51FB\u9009\u62E9</p><input type="file" id="fileInput" accept="image/*" multiple></div>\n<div class="progress" id="progress"></div><div class="counter" id="counter"></div>\n<div class="gallery" id="gallery"></div>\n<div class="empty" id="empty"><div class="icon">\uD83D\uDCF8</div><p>\u6682\u65E0\u56FE\u7247</p></div></div>\n<div class="toast" id="toast"></div>\n<script>\nconst B=\''+o+'\'\nlet A=[]\nfunction T(m){const e=$(\'#toast\');e.textContent=m;e.classList.add(\'show\');setTimeout(()=>e.classList.remove(\'show\'),2500)}\nfunction S(b){if(b<1024)return b+\'B\';if(b<1048576)return(b/1024).toFixed(1)+\'KB\';return(b/1048576).toFixed(1)+\'MB\'}\nasync function L(){try{const r=await fetch(B+\'/?__lsky=list\');const d=await r.json();A=d.images||[];R()}catch{}}\nfunction R(){const g=$(\'#gallery\'),e=$(\'#empty\'),c=$(\'#counter\')\nif(!A.length){g.innerHTML=\'\';e.style.display=\'block\';c.textContent=\'\';return}\ne.style.display=\'none\';c.textContent=\'\u5171 \'+A.length+\' \u5F20\u56FE\u7247\'\ng.innerHTML=A.map(i=>\'<div class=card><img src="\'+B+\'/?__lsky=image&id=\'+i.id+\'" alt="\'+i.name+\'" loading=lazy><div class=info><div class=name title="\'+i.name+\'">\'+i.name+\'</div><div class=size>\'+S(i.size)+\'</div></div><div class=actions><button class=copy-btn onclick="copyUrl(\\\'\'+i.id+\'\\\')" title=\u590D\u5236URL>\uD83D\uDD17</button><button class=del-btn onclick="delImg(\\\'\'+i.id+\'\\\')" title=\u5220\u9664>\uD83D\uDDD1</button></div></div>\').join(\'\')}\nfunction C(p){navigator.clipboard.writeText(B+\'/?__lsky=image&id=\'+p).then(()=>T(\'\u5DF2\u590D\u5236\'))}\nasync function D(id){if(!confirm(\'\u786E\u5B9A\u5220\u9664\uFF1F\'))return;try{const r=await fetch(B+\'/?__lsky=delete&id=\'+id,{method:\'DELETE\'});const d=await r.json();if(d.success){T(\'\u5DF2\u5220\u9664\');L()}else T(\'\u5220\u9664\u5931\u8D25\')}catch{T(\'\u5220\u9664\u5931\u8D25\')}}\nasync function U(files){const p=$(\'#progress\')\nfor(const f of files){if(!f.type.startsWith(\'image/\'))continue\np.style.display=\'block\';p.textContent=\'\u4E0A\u4F20: \'+f.name;const fd=new FormData();fd.append(\'image\',f)\ntry{const r=await fetch(B+\'/?__lsky=upload\',{method:\'POST\',body:fd});const d=await r.json();if(d.success)T(\'\u4E0A\u4F20\u6210\u529F\');else T(\'\u5931\u8D25\')}catch{T(\'\u4E0A\u4F20\u5931\u8D25\')}}\np.style.display=\'none\';L()}\nconst Z=$(\'#dropZone\'),I=$(\'#fileInput\')\nZ.addEventListener(\'click\',()=>I.click())\nZ.addEventListener(\'dragover\',e=>{e.preventDefault();Z.classList.add(\'dragover\')})\nZ.addEventListener(\'dragleave\',()=>Z.classList.remove(\'dragover\'))\nZ.addEventListener(\'drop\',e=>{e.preventDefault();Z.classList.remove(\'dragover\');U(e.dataTransfer.files)})\nI.addEventListener(\'change\',()=>{U(I.files);I.value=\'\'})\nL()\n</script></body></html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ..._LC() } })
}
async function _LH(ctx) {
  const { request } = ctx; const u = new URL(request.url); const p = u.searchParams; const o = u.origin
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: _LC() })
  try {
    const a = p.get('__lsky')
    if (a === null) return null
    if (a === 'upload') { if (request.method !== 'POST') return new Response('MMA', { status: 405, headers: _LC() }); return _LU(request) }
    if (a === 'image') { if (request.method !== 'GET') return new Response('MMA', { status: 405, headers: _LC() }); const id = p.get('id'); if (!id) return new Response('NF', { status: 404, headers: _LC() }); const i = await _LGI(id); if (!i) return new Response('NF', { status: 404, headers: _LC() }); return new Response(i.data, { status: 200, headers: { 'Content-Type': i.type, 'Cache-Control': 'public, max-age=31536000, immutable', ..._LC() } }) }
    if (a === 'list') { if (request.method !== 'GET') return new Response('MMA', { status: 405, headers: _LC() }); return _LL() }
    if (a === 'delete') { if (request.method !== 'DELETE') return new Response('MMA', { status: 405, headers: _LC() }); const id = p.get('id'); if (!id) return new Response(JSON.stringify({ error: 'no id' }), { status: 400, headers: _LC() }); await _LD(id); return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json', ..._LC() } }) }
    return _LF(u)
  } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', ..._LC() } }) }
}

/** Handle Twikoo UPLOAD_IMAGE for lskypro directly */
async function _handleLskyUploadForTwikoo(event) {
  const photo = event.photo; const fileName = event.fileName || 'image.png'
  if (!photo) throw new Error('no image data')
  const raw = atob(photo.split(',')[1] || photo)
  const buf = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i)
  const ft = fileName.match(/\.(png|jpg|jpeg|gif|webp|avif|svg)$/i)?.[1] || 'png'
  const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml' })[ft.toLowerCase()] || 'image/png'
  if (buf.byteLength > _LSZ) throw new Error('file too large')
  if (!_LAT.includes(mime)) throw new Error('unsupported type')
  const id = uuidv4().replace(/-/g, ''); const ex = _LE(mime)
  await _LA(id, buf, { id, name: fileName, ext: ex, type: mime, size: buf.byteLength, created: Date.now(), updated: Date.now() })
  const url = `https://comment.asterias.top/?__lsky=image&id=${id}`
  return { data: { url, links: { url } } }
}

// EdgeOne Pages Node Function 入口
export async function onRequest (context) {
  const { request } = context

  // ===== Lsky Lite 路由 =====
  try {
    const _u = new URL(request.url)
    if (_u.searchParams.has('__lsky')) return _LH(context)
  } catch (e) { /* fall through */ }

  // eslint-disable-next-line no-async-promise-executor
  return new Promise(async (resolve) => {
    try {
      const url = new URL(request.url)
      const method = request.method

      // 构造模拟的 req 对象
      const headers = {}
      request.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })

      // Admin API 需要原始 body（不预先消费）
      if (method === 'POST' && url.searchParams.get('action')) {
        const res = {
          status: (code) => { /* handled in handleAdmin */ return res },
          setHeader: (name, value) => { /* handled in handleAdmin */ },
          json: (data) => {
            resolve(new Response(JSON.stringify(data), {
              status: 200,
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            }))
          },
          send: (data) => {
            resolve(new Response(data, {
              status: 200,
              headers: { 'Access-Control-Allow-Origin': '*' }
            }))
          }
        }
        try {
          await handleAdmin(request, url, res)
        } catch (e) {
          resolve(new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          }))
        }
        return
      }

      let body = null
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        try {
          body = await request.json()
        } catch (e) {
          body = {}
        }
      }

      const req = {
        method,
        url: url.pathname + url.search,
        path: url.pathname,
        headers,
        body,
        ip: headers['x-real-ip'] || headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown',
        protocol: url.protocol.replace(':', ''),
        get: (name) => headers[name.toLowerCase()]
      }

      // 构造模拟的 res 对象
      let statusCode = 200
      const resHeaders = {}
      let resBody = null

      const res = {
        status: (code) => { statusCode = code; return res },
        setHeader: (name, value) => { resHeaders[name] = value },
        set: (name, value) => { resHeaders[name] = value },
        json: (data) => {
          resHeaders['Content-Type'] = 'application/json'
          resBody = JSON.stringify(data)
          finish()
        },
        send: (data) => {
          resBody = data
          finish()
        },
        end: () => finish()
      }

      function finish () {
        resolve(new Response(resBody, {
          status: statusCode,
          headers: resHeaders
        }))
      }

      // 手动处理路由
      console.log(`[${new Date().toISOString()}] ${method} ${url.pathname}`)

      // CORS 处理
      const origin = headers.origin
      if (origin) {
        res.setHeader('Access-Control-Allow-Credentials', 'true')
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version')
        res.setHeader('Access-Control-Max-Age', '600')
      }

      if (method === 'OPTIONS') {
        res.status(204).end()
        return
      }

      if (method === 'GET') {
        // 资源代理：任意 GET 带 ?key= 参数 → 从 Blob 读取文件
        if (url.searchParams.get('key')) {
          await handleResource(url, res);
          return;
        }
        res.json({
          code: RES_CODE.SUCCESS,
          message: 'Twikoo 云函数运行正常，请参考 https://twikoo.js.org/frontend.html 完成前端的配置',
          version: VERSION
        })
        return
      }

      if (method === 'POST') {
        // 调用主处理逻辑
        await handlePost(req, res)
        return
      }

      res.status(404).json({ code: 404, message: 'Not Found' })
    } catch (e) {
      console.error('onRequest error:', e)
      resolve(new Response(JSON.stringify({ code: 500, message: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }))
    }
  })
}

async function qqNickGet (event) {
  const res = {}
  try {
    validate(event, ['qq'])
    const nick = await getQQNick(event.qq, config.QQ_API_KEY)
    res.code = RES_CODE.SUCCESS
    res.nick = nick
  } catch (e) {
    res.code = RES_CODE.FAIL
    res.message = e.message
  }
  return res
}

// POST 请求处理主逻辑
async function handlePost (req, res) {
  let accessToken
  const event = req.body || {}
  const ip = getIp(req)

  logger.log('请求 IP：', ip)
  logger.log('请求函数：', event.event)
  logger.log('请求参数：', event)

  let result = {}

  try {
    // 防护
    protect(ip)

    // 生成或使用 accessToken
    accessToken = event.accessToken || uuidv4().replace(/-/g, '')

    // 读取配置
    await readConfig()

    // 创建数据库操作对象
    const db = createBlobDatabase()

    switch (event.event) {
      case 'GET_FUNC_VERSION':
        result = getFuncVersion({ VERSION })
        break
      case 'COMMENT_GET':
        result = await commentGet(event, db, accessToken)
        break
      case 'COMMENT_GET_FOR_ADMIN':
        result = await commentGetForAdmin(event, db, accessToken)
        break
      case 'COMMENT_SET_FOR_ADMIN':
        result = await commentSetForAdmin(event, db, accessToken)
        break
      case 'COMMENT_DELETE_FOR_ADMIN':
        result = await commentDeleteForAdmin(event, db, accessToken)
        break
      case 'COMMENT_DELETE_FOR_USER':
        result = await commentDeleteForUser(event, db, accessToken)
        break
      case 'COMMENT_IMPORT_FOR_ADMIN':
        result = await commentImportForAdmin(event, db, accessToken)
        break
      case 'COMMENT_LIKE':
        result = await commentLike(event, db, accessToken)
        break
      case 'COMMENT_SUBMIT':
        result = await commentSubmit(event, req, db, accessToken)
        break
      case 'COUNTER_GET':
        result = await counterGet(event, db)
        break
      case 'GET_PASSWORD_STATUS':
        result = await getPasswordStatus(config, VERSION)
        break
      case 'SET_PASSWORD':
        result = await setPassword(event, db, accessToken)
        break
      case 'GET_CONFIG':
        result = await getConfig({ config, VERSION, isAdmin: isAdmin(accessToken) })
        break
      case 'GET_CONFIG_FOR_ADMIN':
        result = await getConfigForAdmin({ config, isAdmin: isAdmin(accessToken) })
        break
      case 'SET_CONFIG':
        result = await setConfig(event, db, accessToken)
        break
      case 'LOGIN':
        result = await login(event.password)
        break
      case 'GET_COMMENTS_COUNT':
        result = await getCommentsCount(event, db)
        break
      case 'GET_RECENT_COMMENTS':
        result = await getRecentComments(event, db)
        break
      case 'EMAIL_TEST':
        result = await emailTest(event, config, isAdmin(accessToken))
        break
      case 'UPLOAD_IMAGE':
        result = await _handleLskyUploadForTwikoo(event)
        break
      case 'COMMENT_EXPORT_FOR_ADMIN':
        result = await commentExportForAdmin(event, db, accessToken)
        break
      case 'GET_QQ_NICK':
        result = await qqNickGet(event)
        break
      default:
        if (event.event) {
          result.code = RES_CODE.EVENT_NOT_EXIST
          result.message = '请更新 Twikoo 云函数至最新版本'
        } else {
          result.code = RES_CODE.NO_PARAM
          result.message = 'Twikoo 云函数运行正常，请参考 https://twikoo.js.org/frontend.html 完成前端的配置'
          result.version = VERSION
        }
    }

    if (!result.code && !event.accessToken) {
      result.accessToken = accessToken
    }
  } catch (e) {
    logger.error('Twikoo 遇到错误：', e.message, e.stack)
    result.code = RES_CODE.FAIL
    result.message = e.message
  }

  logger.log('请求返回：', result)
  res.json(result)
}
