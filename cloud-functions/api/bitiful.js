/**
 * EdgeOne Pages Function — Bitiful S3 代理
 * 使用只读密钥签名请求，代理到 Bitiful S3
 * 
 * 部署到 EdgeOne Pages 函数的 /api/bitiful 路径
 * 用法: https://your-project.edgeone.app/api/bitiful?key=js/app.js
 */

const https = require('https');
const crypto = require('crypto');

// Bitiful S3 只读密钥（前端安全）
const ACCESS_KEY = process.env.BITIFUL_ACCESS_KEY || 'lKnad3cpfMjXazmw6iPU3HvC';
const SECRET_KEY = process.env.BITIFUL_SECRET_KEY || 'W94emz8M6CVpM7ycidmt4HyF6gHINcb';
const BUCKET = 'my-blob-resource';
const ENDPOINT = 's3.bitiful.net';
const REGION = 'us-east-1';
const SERVICE = 's3';

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function getSignatureKey(key, dateStamp, region, service) {
  const kDate = hmac('AWS4' + key, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function signRequest(method, key, headers, payload) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.substring(0, 8);

  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = sha256(payload || '');
  headers['host'] = `${BUCKET}.${ENDPOINT}`;

  const signedHeaders = Object.keys(headers)
    .filter(h => h.startsWith('x-amz-') || h === 'host')
    .sort()
    .join(';');

  const canonicalHeaders = Object.keys(headers)
    .filter(h => h.startsWith('x-amz-') || h === 'host')
    .sort()
    .map(h => `${h}:${headers[h]}`)
    .join('\n');

  const canonicalRequest = [
    method,
    `/${key}`,
    '',
    canonicalHeaders,
    '',
    signedHeaders,
    headers['x-amz-content-sha256'],
  ].join('\n');

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');

  const signingKey = getSignatureKey(SECRET_KEY, dateStamp, REGION, SERVICE);
  const signature = hmac(signingKey, stringToSign).toString('hex');

  return `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

exports.main = async (event) => {
  const { key } = event.queryStringParameters || {};
  if (!key) return { statusCode: 400, body: 'Missing ?key=' };

  const headers = {};
  const authorization = signRequest('GET', key, headers);

  headers['Authorization'] = authorization;
  headers['Accept'] = '*/*';

  return new Promise((resolve) => {
    const req = https.request({
      hostname: `${BUCKET}.${ENDPOINT}`,
      port: 443,
      path: `/${encodeURI(key)}`,
      method: 'GET',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const ct = res.headers['content-type'] || 'application/octet-stream';
        resolve({
          statusCode: res.statusCode,
          headers: {
            'Content-Type': ct,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'ETag': res.headers.etag || '',
          },
          body: body.toString('base64'),
          isBase64Encoded: true,
        });
      });
    });
    req.on('error', (e) => resolve({ statusCode: 502, body: e.message }));
    req.end();
  });
};
