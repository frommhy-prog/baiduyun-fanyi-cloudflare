# 百度云翻译（Cloudflare Worker）

线上（部署后）：`https://baiduyunfanyi.from-mhy.workers.dev`

主路径：**百度智能云图片翻译**（`paste=1` → `data.pasteImg` 整图贴合 Base64），供 iOS 快捷指令使用。

与旧仓 `tengxunyun-fanyi-cloudflare`（腾讯霓虹叠字 / 直接显示）分离，互不影响。

## 必填 Secrets（勿写入 git）

在 Cloudflare Dashboard → Workers → Settings → Variables → Secrets 配置：

| Secret | 说明 |
|--------|------|
| `BAIDU_API_KEY` | 百度 AI 开放平台 API Key（别名亦可：`BAIDU_APP_ID`） |
| `BAIDU_SECRET_KEY` | 百度 Secret Key（别名亦可：`BAIDU_SECRET`） |

```bash
npx wrangler secret put BAIDU_API_KEY
npx wrangler secret put BAIDU_SECRET_KEY
```

**不要**把密钥写进 `wrangler.toml` 或提交到仓库。

## 快捷指令（推荐：JSON + Base64 图，直接显示）

默认 POST 返回 **`application/json`**，字段 `image` 为百度贴合图的 Base64（`imageMime: image/jpeg` 或 `image/png`，`overlay: baidu-paste`）。不要再用浏览器打开 Worker URL，也不要对 URL 做「快速查看」——会触发 iOS 文件表（完成/取消）。

1. 截屏 / 选图
2. **调整图像大小**（宽 **800～1200**；长边 ≤4096）
3. **转换为 JPEG**
4. **获取 URL 内容**
   - URL：`https://baiduyunfanyi.from-mhy.workers.dev/`
   - 方法：POST
   - **头部**：只留 `Content-Type` = `image/jpeg`（**删掉空白键**）
   - **请求体**：选 **文件**，选上一步的 JPEG
5. **获取字典值** → 键 `image`
6. **用 Base64 解码**
7. **显示结果** / **快速查看**（解码后的图片）

## 兼容：JSON 请求体

1. JPEG → **用 Base64 编码**（raw）
2. 请求体：`{"imageBase64":"..."}`
3. 头部只有 `Content-Type: application/json`
4. 同样取字典值 `image` → Base64 解码 → 显示

## 响应形状

```json
{
  "image": "<pasteImg base64>",
  "imageMime": "image/jpeg",
  "translation": "<data.sumDst>",
  "overlay": "baidu-paste"
}
```

仅当 URL 带 **`?raw=1`** 时返回原始图片二进制（`Content-Type: image/jpeg` 或 `image/png`），而不是 JSON。

## 常见报错

| 现象 | 原因 |
|------|------|
| Cloudflare **400 Bad Request** 白页 | 请求头有**空的键**，或 JSON 体非法 |
| 浏览器打开网站像 **404 / NoSuchKey** | 那是用浏览器 GET；本 Worker 只处理 POST。打开应看到说明页 |
| 「完成 / 取消」文件表 | 旧流程对 raw URL 快速查看；请改用 JSON → 取 `image` → Base64 解码 |
| 「无项目」 | 不要对 Base64 **文本**做快速查看 |
| 缺少 Secrets 中文报错 | 未配置 `BAIDU_API_KEY` / `BAIDU_SECRET_KEY` |

上游超时固定 9000ms。access_token 在 Worker 模块内缓存至 `expires_in - 60s`。
