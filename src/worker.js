const UPSTREAM_TIMEOUT_MS = 9000;
const MAX_IMAGE_EDGE = 4096;
/** Cache version — bump when translation policy changes. */
const CACHE_VER = "baidu:v3-foreign";

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
<p>默认 <code>from=auto</code>；若检出外文（英/日/韩/俄等）却未翻译，会按语种<strong>自动再请求一次</strong>（如 <code>from=en|jp|kor|ru</code>）。</p>
<p>只接受 <b>POST</b>。默认返回 <code>application/json</code>（含 Base64 图）。显式 <code>?raw=1</code> 返回图片二进制。</p>
<p>快捷指令推荐：宽 800 → JPEG → POST <code>?raw=1</code> → 显示结果（不要取字典/Base64）。</p>
<p>Secrets：<code>BAIDU_API_KEY</code> + <code>BAIDU_SECRET_KEY</code>。</p>
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

function guessImageMime(b64) {
  const s = stripDataUrl(b64);
  if (s.startsWith("iVBOR")) return "image/png";
  return "image/jpeg";
}

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

/** Baidu pictrans `from` codes we allow as override / retry. */
const ALLOWED_FROM = new Set([
  "auto",
  "en",
  "jp",
  "kor",
  "fra",
  "spa",
  "ru",
  "pt",
  "de",
  "it",
  "dan",
  "nl",
  "may",
  "ara",
  "hi",
  "th",
  "vie",
  "id",
]);

/** Optional override: ?from=en|jp|kor|…|auto or body.from */
function wantFrom(request, body) {
  try {
    const u = new URL(request.url);
    const q = (u.searchParams.get("from") || "").trim().toLowerCase();
    if (ALLOWED_FROM.has(q)) return q;
  } catch (_) {}
  if (body && typeof body.from === "string") {
    const f = body.from.trim().toLowerCase();
    if (ALLOWED_FROM.has(f)) return f;
  }
  return null;
}

function isJpegBytes(bytes) {
  return bytes && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

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

/** Count chars matching a unicode regex. */
function countRe(s, re) {
  return (String(s || "").match(re) || []).length;
}

/**
 * Non-Chinese foreign text (Latin / JP / KR / Cyrillic / Arabic / Thai / …).
 * Pure CJK or punctuation-only → false.
 */
function looksForeign(text) {
  const s = String(text || "").trim();
  if (s.length < 2) return false;
  const cjk = countRe(s, /[\u4e00-\u9fff]/g);
  const latin = countRe(s, /[A-Za-z]/g);
  const kana = countRe(s, /[\u3040-\u30ff]/g);
  const hangul = countRe(s, /[\uac00-\ud7af]/g);
  const cyr = countRe(s, /[\u0400-\u04ff]/g);
  const arab = countRe(s, /[\u0600-\u06ff]/g);
  const thai = countRe(s, /[\u0e00-\u0e7f]/g);
  const foreign = latin + kana + hangul + cyr + arab + thai;
  if (foreign < 2) return false;
  return foreign >= cjk;
}

/** Pick Baidu `from` for untranslated foreign blocks (dominant script). */
function detectRetryFrom(content) {
  let latin = 0,
    kana = 0,
    hangul = 0,
    cyr = 0,
    arab = 0,
    thai = 0;
  for (const block of content || []) {
    const src = String(block?.src ?? "");
    const dst = String(block?.dst ?? "");
    if (!looksForeign(src) || src !== dst) continue;
    latin += countRe(src, /[A-Za-z]/g);
    kana += countRe(src, /[\u3040-\u30ff]/g);
    hangul += countRe(src, /[\uac00-\ud7af]/g);
    cyr += countRe(src, /[\u0400-\u04ff]/g);
    arab += countRe(src, /[\u0600-\u06ff]/g);
    thai += countRe(src, /[\u0e00-\u0e7f]/g);
  }
  const scores = [
    ["kor", hangul],
    ["jp", kana],
    ["ru", cyr],
    ["ara", arab],
    ["th", thai],
    ["en", latin],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  if (!scores[0] || scores[0][1] < 2) return null;
  return scores[0][0];
}

/** auto 结果里：有外文块且 src===dst → 需要按语种再翻一次 */
function needsForeignRetry(content) {
  return detectRetryFrom(content) != null;
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
      const fromOverride = wantFrom(request, body);
      const cacheKey =
        (await sha256Hex(imageBase64)) +
        (rawOut ? ":raw" : ":json") +
        ":" +
        CACHE_VER +
        (fromOverride ? ":from=" + fromOverride : "");
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

      const baidu = await translateImageSmart(imageBase64, env, fromOverride);
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
        from: baidu.fromUsed,
        foreignRetry: baidu.foreignRetry === true,
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

/**
 * auto first; if any foreign text left untranslated, retry with detected from.
 * Explicit fromOverride skips the heuristic.
 */
async function translateImageSmart(imageBase64, env, fromOverride) {
  if (fromOverride && ALLOWED_FROM.has(fromOverride)) {
    const one = await translateImageViaBaidu(imageBase64, env, fromOverride);
    return { ...one, fromUsed: fromOverride, foreignRetry: false };
  }

  const auto = await translateImageViaBaidu(imageBase64, env, "auto");
  const retryFrom = detectRetryFrom(auto.content);
  if (!retryFrom) {
    return { ...auto, fromUsed: "auto", foreignRetry: false };
  }
  const second = await translateImageViaBaidu(imageBase64, env, retryFrom);
  return { ...second, fromUsed: retryFrom, foreignRetry: true };
}

async function translateImageViaBaidu(imageBase64, env, fromLang) {
  const accessToken = await getBaiduAccessToken(env);
  const jpegBytes = base64ToBytes(imageBase64);
  const from =
    fromLang && fromLang !== "auto" && ALLOWED_FROM.has(fromLang)
      ? fromLang
      : "auto";

  const form = new FormData();
  form.append(
    "image",
    new Blob([jpegBytes], { type: "image/jpeg" }),
    "image.jpg"
  );
  form.append("from", from);
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
    content: Array.isArray(json.data?.content) ? json.data.content : [],
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
