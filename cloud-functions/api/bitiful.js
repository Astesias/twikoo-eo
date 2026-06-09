/**
 * EdgeOne Pages Function — Bitiful S3 代理
 * 使用只读密钥签名请求，代理到 Bitiful S3
 * 
 * 部署路径: cloud-functions/api/bitiful.js
 * 用法: https://resource.asterias.top/api/bitiful?key=js/app.js
 */

const ACCESS_KEY = process.env.BITIFUL_ACCESS_KEY || 'lKnad3cpfMjXazmw6iPU3HvC';
const SECRET_KEY = process.env.BITIFUL_SECRET_KEY || 'W94emz8M6CVpM7ycidmt4HyF6gHINcb';
const BUCKET = 'my-blob-resource';
const ENDPOINT = 's3.bitiful.net';
const REGION = 'us-east-1';

async function sha256(data) {
  const d = new TextEncoder().encode(data);
  const h = await crypto.subtle.digest('SHA-256', d);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key, data) {
  const k = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const d = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const cryptoKey = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, d);
  return new Uint8Array(sig);
}

function toHex(buf) {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function signRequest(method, objectKey) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.substring(0, 8);
  const payloadHash = await sha256('');
  const host = `${BUCKET}.${ENDPOINT}`;

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    method,
    `/${objectKey}`,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256(canonicalRequest),
  ].join('\n');

  const kDate = await hmacSha256('AWS4' + SECRET_KEY, dateStamp);
  const kRegion = await hmacSha256(kDate, REGION);
  const kService = await hmacSha256(kRegion, 's3');
  const signingKey = await hmacSha256(kService, 'aws4_request');
  const signature = toHex(await hmacSha256(signingKey, stringToSign));

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate,
    payloadHash,
  };
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const key = url.searchParams.get('key');
  if (!key) return new Response('Missing ?key=', { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });

  try {
    const { authorization, amzDate, payloadHash } = await signRequest('GET', key);

    const s3Url = `https://${BUCKET}.${ENDPOINT}/${encodeURI(key)}`;
    const resp = await fetch(s3Url, {
      headers: {
        'Authorization': authorization,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        'host': `${BUCKET}.${ENDPOINT}`,
      },
    });

    if (!resp.ok) {
      return new Response(`S3 ${resp.status}`, { status: resp.status, headers: { 'Access-Control-Allow-Origin': '*' } });
    }

    const body = await resp.arrayBuffer();
    const ct = resp.headers.get('content-type') || 'application/octet-stream';
    const etag = resp.headers.get('etag') || '';

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': ct,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'ETag': etag,
      },
    });
  } catch (e) {
    return new Response(e.message, { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
}
