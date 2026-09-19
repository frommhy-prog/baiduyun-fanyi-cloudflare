const UPSTREAM_TIMEOUT_MS = 9000;
const MAX_IMAGE_EDGE = 4096;

/** Module-scope Baidu access_token cache (expires_in - 60s). */
let baiduToken = null;
let baiduTokenExpiresAt = 0;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function helpHtml() {
  return `<!doctype html><meta charset=utf-8><title>百度云翻译</title>
<body style="font-family:system-ui;max-width:40rem;margin:2rem auto;line-height:1.5">
<h1>百度云翻译 Worker</h1>
<p>主路径：<b>百度智能云图片翻译</b>（pictrans <code>paste=1</code> → <code>data.pasteImg</code> 整图贴合）。</p>
<p>只接受 <b>POST</b>。默认返回 <code>application/json</code>（含 Base64 图），避免 iOS 弹出「完成/取消」文件表。</p>
<p>iOS 快捷指令推荐步骤：</p>
<ol>
<li>截屏 → 调整图像大小（宽 800～1200；长边 ≤4096）→ 转 JPEG</li>
<li>获取 URL 内容 → POST 到 <code>https://baiduyunfanyi.from-mhy.workers.dev/</code></li>
<li>请求体：文件 JPEG（<code>Content-Type: image/jpeg</code>）或 JSON <code>{"imageBase64":"..."}</code></li>
<li>获取字典值 <code>image</code></li>
<li>用 Base64 解码</li>
<li>显示结果 / 快速查看（不要用浏览器打开 Worker URL）</li>
</ol>
<p>仅当显式加 <code>?raw=1</code> 时返回原始 <code>image/jpeg</code>（或 PNG）二进制，而不是 JSON。</p>
<p>勿留空的请求头键；勿在解码前快速查看 Base64 文本。</p>
<p>Secrets：<code>BAIDU_API_KEY</code> + <code>BAIDU_SECRET_KEY</code>（别名 <code>BAIDU_APP_ID</code> / <code>BAIDU_SECRET</code>）。</p>
</body>`;
}

function readBaiduSecrets(env) {
  const apiKey = String(env.BAIDU_API_KEY || env.BAIDU_APP_ID || "").trim();
  const secretKey = String(
    env.BAIDU_SECRET_KEY || env.BAIDU_SECRET || ""
  ).trim();
  if (!apiKey || !secretKey) {
    throw new Error(
      "Worker 缺少 Secrets：请在 Cloudflare 配置 BAIDU_API_KEY 与 BAIDU_SECRET_KEY（亦接受别名 BAIDU_APP_ID / BAIDU_SECRET）"
    );
  }
  return { apiKey, secretKey };
}

function stripDataUrl(imageBase64) {
  const s = String(imageBase64 || "").trim();
  const idx = s.indexOf("base64,");
  if (s.startsWith("data:image/") && idx !== -1) {
    return s.slice(idx + "base64,".length).replace(/\s+/g, "");
  }
  return s.replace(/\s+/g, "");
}

/** Detect mime from base64 magic (PNG vs JPEG). */
function guessImageMime(b64) {
  const s = stripDataUrl(b64);
  if (s.startsWith("iVBOR")) return "image/png";
  return "image/jpeg";
}

/** Raw binary body only when explicitly requested. */
function wantRaw(request, body) {
  try {
    const u = new URL(request.url);
    if (u.searchParams.get("raw") === "1") return true;
  } catch (_) {}
  if (body && (body.raw === true || body.raw === 1 || body.raw === "1")) {
    return true;
  }
  return false;
}

function isJpegBytes(bytes) {
  return bytes && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/** Read JPEG base64 from JSON, raw image/*, multipart, or mislabeled binary. */
async function readImageBase64(request) {
  const ct = (request.headers.get("Content-Type") || "").toLowerCase();

  if (ct.startsWith("image/")) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!isJpegBytes(bytes)) {
      throw new Error("请上传 JPEG 图片（Content-Type: image/jpeg）");
    }
    return { imageBase64: bufToBase64(bytes), body: null };
  }

  if (ct.includes("multipart/form-data")) {
    const form = await request.formData();
    const file =
      form.get("image") ||
      form.get("file") ||
      form.get("imageBase64") ||
      form.get("photo");
    if (file && typeof file.arrayBuffer === "function") {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isJpegBytes(bytes)) {
        throw new Error("表单文件请用 JPEG");
      }
      return { imageBase64: bufToBase64(bytes), body: null };
    }
    const textField = form.get("imageBase64");
    if (typeof textField === "string" && textField.trim()) {
      return { imageBase64: stripDataUrl(textField), body: null };
    }
    throw new Error("multipart 缺少 image / file / imageBase64");
  }

  const raw = new Uint8Array(await request.arrayBuffer());
  if (isJpegBytes(raw)) {
    return { imageBase64: bufToBase64(raw), body: null };
  }

  let text = "";
  try {
    text = new TextDecoder().decode(raw);
  } catch (_) {
    throw new Error("无法读取请求体");
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    throw new Error(
      '请求体无效：JSON 需 {"imageBase64":"..."}，或 Content-Type: image/jpeg 直接传文件。请删掉空的请求头，并先「用 Base64 编码」再填 JSON。'
    );
  }

  const imageBase64Raw = body?.imageBase64;
  if (!imageBase64Raw) {
    throw new Error("Missing imageBase64");
  }
  const s = String(imageBase64Raw).trim();
  if (s === "文本" || s.length < 32) {
    throw new Error(
      "imageBase64 不是有效 Base64。请增加「用 Base64 编码」步骤，或把请求体改成「文件」并选 JPEG（Worker 已支持）。"
    );
  }
  return { imageBase64: stripDataUrl(s), body };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET" || request.method === "HEAD") {
      return new Response(helpHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Only POST supported" }, 405);
    }

    try {
      const { imageBase64, body } = await readImageBase64(request);
      const { width, height } = getJpegSize(imageBase64);
      if (Math.max(width, height) > MAX_IMAGE_EDGE) {
        return jsonResponse(
          {
            error:
              "图片长边超过上限 " +
              MAX_IMAGE_EDGE +
              "；竖屏宽 1200 一般可用，不必反复改快捷指令，请确认图片长边不超过 " +
              MAX_IMAGE_EDGE,
          },
          400
        );
      }

      const rawOut = wantRaw(request, body);
      const cacheKey =
        (await sha256Hex(imageBase64)) +
        (rawOut ? ":raw" : ":json") +
        ":baidu";
      const cached = await env.IMG_TRANSLATE_CACHE?.get(cacheKey);
      if (cached) {
        if (rawOut) {
          const mime = guessImageMime(cached);
          return new Response(base64ToBytes(cached), {
            headers: { "Content-Type": mime },
          });
        }
        return new Response(cached, {
          headers: { "Content-Type": "application/json" },
        });
      }

      const baidu = await translateImageViaBaidu(imageBase64, env);
      const pasteImg = stripDataUrl(baidu.pasteImg);
      const imageMime = guessImageMime(pasteImg);

      if (rawOut) {
        if (env.IMG_TRANSLATE_CACHE) {
          ctx.waitUntil(
            env.IMG_TRANSLATE_CACHE.put(cacheKey, pasteImg, {
              expirationTtl: 60 * 60 * 24 * 30,
            })
          );
        }
        return new Response(base64ToBytes(pasteImg), {
          headers: { "Content-Type": imageMime },
        });
      }

      const resultPayload = JSON.stringify({
        image: pasteImg,
        imageMime,
        translation: baidu.sumDst || "",
        overlay: "baidu-paste",
      });

      if (env.IMG_TRANSLATE_CACHE) {
        ctx.waitUntil(
          env.IMG_TRANSLATE_CACHE.put(cacheKey, resultPayload, {
            expirationTtl: 60 * 60 * 24 * 30,
          })
        );
      }

      return new Response(resultPayload, {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const status = err.name === "AbortError" ? 504 : 500;
      return jsonResponse({ error: err.message || String(err) }, status);
    }
  },
};

async function getBaiduAccessToken(env) {
  const now = Date.now();
  if (baiduToken && now < baiduTokenExpiresAt) {
    return baiduToken;
  }
  const { apiKey, secretKey } = readBaiduSecrets(env);
  const url =
    "https://aip.baidubce.com/oauth/2.0/token" +
    `?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}` +
    `&client_secret=${encodeURIComponent(secretKey)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, { method: "POST", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  const json = await resp.json();
  if (!json.access_token) {
    const msg =
      json.error_description ||
      json.error ||
      "百度 access_token 获取失败";
    throw new Error(String(msg));
  }
  const expiresIn = Number(json.expires_in) || 2592000;
  baiduToken = json.access_token;
  baiduTokenExpiresAt = now + Math.max(60, expiresIn - 60) * 1000;
  return baiduToken;
}

async function translateImageViaBaidu(imageBase64, env) {
  const accessToken = await getBaiduAccessToken(env);
  const jpegBytes = base64ToBytes(imageBase64);

  const form = new FormData();
  form.append(
    "image",
    new Blob([jpegBytes], { type: "image/jpeg" }),
    "image.jpg"
  );
  form.append("from", "auto");
  form.append("to", "zh");
  form.append("v", "3");
  form.append("paste", "1");

  const url =
    "https://aip.baidubce.com/file/2.0/mt/pictrans/v1" +
    `?access_token=${encodeURIComponent(accessToken)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const json = await resp.json();
  const code = json.error_code;
  const ok = code === 0 || code === "0";
  if (!ok) {
    const msg =
      json.error_msg ||
      json.error_description ||
      `百度图片翻译失败 (error_code=${code})`;
    throw new Error(String(msg));
  }

  const pasteImg = json.data?.pasteImg;
  if (!pasteImg) {
    throw new Error("百度未返回 data.pasteImg（请确认 paste=1）");
  }
  return {
    pasteImg: String(pasteImg),
    sumDst: json.data?.sumDst != null ? String(json.data.sumDst) : "",
  };
}

function getJpegSize(imageBase64) {
  const bin = atob(imageBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  let i = 0;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("无法解析图片尺寸（请传 JPEG raw base64）");
  }
  i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      throw new Error("无法解析图片尺寸（请传 JPEG raw base64）");
    }
    const marker = bytes[i + 1];
    i += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    const len = (bytes[i] << 8) + bytes[i + 1];
    if (
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3
    ) {
      const height = (bytes[i + 3] << 8) + bytes[i + 4];
      const width = (bytes[i + 5] << 8) + bytes[i + 6];
      return { width, height };
    }
    i += len;
  }
  throw new Error("无法解析图片尺寸（请传 JPEG raw base64）");
}

async function sha256Hex(message) {
  const data = new TextEncoder().encode(message);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return bufToHex(hash);
}

function bufToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bufToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const bin = atob(stripDataUrl(b64));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
