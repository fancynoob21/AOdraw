# AOdraw

在 SillyTavern **流式回复的过程中**截获正文里的 `[img: ...]`，立刻开始生成 NovelAI 图片 ——
不必等正文写完。

## 为什么

现有的生图工作流都是串行的：

```
正文生成完 ──▶ 渲染完成 ──▶ 提取 [img:] ──▶ 排队发 NAI ──▶ 出图
   20s                                        15s
                        总共 35s
```

但 `[img: 1girl, smile, cafe]` 在流式传输到 `]` 的那一刻就已经**语义完整**了 ——
此时正文可能才写了三分之一。没有理由要等正文写完才开始调 NAI。

```
正文生成 ────────────────────▶
        └─ [img:] 闭合，立刻派发
           画图 ──────────▶
                        总共 ~20s
```

正文写完的时候，第一张图往往已经就绪了。

## 安装

SillyTavern → 扩展 → 安装扩展 → 填入本仓库的 Git URL。

装好后在扩展设置里填 NovelAI API Key，点「测试」确认有效。

## 用法

让模型在正文里输出这种标记：

```
她把手机转过来给你看。
[img: 1girl, smile, cafe, window light, casual clothes]
"就是这张。"
```

把设置面板底部那段「提示词规范」复制进角色卡或预设，模型就会照着写。

格式可以在设置里改（默认同时接受 `[img: ...]` 和 `[图片: ...]`）。
自定义正则必须满足两个条件：

- 含捕获组 1，即 prompt 本身
- **必须要求闭合定界符**。这是整个设计成立的前提 —— 正则不匹配半截 token，
  才能保证流式过程中不会拿着 `[img: 1gir` 就把请求发出去。

### 图片上的操作

鼠标悬停在图上会出现工具条：

| | |
|---|---|
| 🔄 | 重绘（同 prompt，绕过缓存） |
| ✏️ | 修改 prompt |
| ↩️ | 复位为正文里的原始 prompt |
| 📌 | 长期保存（不受缓存清理影响） |

楼层右上角的 `···` 里有一个 🖼 按钮，打开本楼图片的管理面板 ——
在有好几张图、其中几张失败几张排队的时候比逐张悬停方便。

**改 prompt 不会动正文。** 修改存在一张 override 表里，键是正文原始 prompt 的 hash。
所以 `[img: ...]` 原文照常进 LLM 上下文，而你的修改也不会在下一次重绘中丢失。

### 缓存

图片存在浏览器的 IndexedDB 里，默认保留 7 天（设置里可改，填 `0` 表示永不过期）。
相同的 prompt 只会真正生成一次，之后一律走缓存 —— swipe 回旧回复、刷新页面都是秒出。

翻阅历史楼层时，**缓存里没有的图不会自动生成**，只显示一个「生成」按钮。
滚一遍聊天记录就静默烧光 Anlas 是不可接受的。

## 限制

- 只支持 `nai-diffusion-4-5-full`。不支持 V3、Curated，也不支持其他后端。
- 生成是**严格串行**的，图与图之间还有 5–10s 随机冷却 —— NovelAI 单个 API Key
  不支持并发。本插件的收益来自派发时机，不是并发数。
- 依赖 `encode_tags` 保持关闭（SillyTavern 默认就是关的）。
- 图片只存在浏览器本地，不写进聊天记录，也不导出。

## 开发

```bash
git clone <repo> ~/Documents/AOdraw
ln -s ~/Documents/AOdraw \
      <SillyTavern>/public/scripts/extensions/third-party/AOdraw
npm test
```

无构建步骤，纯 ESM，无运行时依赖。改完刷新浏览器即可。

`npm test` 跑的是不依赖 SillyTavern 的那部分：token 扫描器（逐字符喂流，断言派发时机）、
ZIP 解包（stored / deflate 两种真实 fixture）、NAI 报文构造。

`test/browser/timing.mjs` 验证本插件的核心主张本身 —— 它驱动一个真实的 SillyTavern
页面，模拟含两个 `[img:]` 的流式回复，核对第一个 NovelAI 请求发出的时刻是否早于
正文流结束的时刻。NovelAI 请求会被拦截，不消耗 Anlas。需要手动跑：

```bash
node server.js --port 8123 --listen false      # 在 SillyTavern 目录
ST_URL=http://127.0.0.1:8123 node test/browser/timing.mjs
```

典型输出（正文流 236ms，第一张图在 49ms 就发出去了）：

```
  chunk  9 — [AOdraw] dispatch @ +50ms — 1girl, smile, cafe
  chunk 35 — [AOdraw] dispatch @ +199ms — 2girls, rain, umbrella
  正文流结束于 +236ms
  NovelAI 请求发出时刻: +49ms, +201ms
```

### 结构

| 文件 | 职责 |
|---|---|
| `src/scanner.js` | 流式 token 扫描器。全量重扫 + 位置去重，靠「正则要求闭合」保证不误派发 |
| `src/pipeline.js` | 串行队列、缓存查询、同 prompt 去重、状态广播 |
| `src/nai-client.js` | NAI 4.5 Full 报文构造与请求 |
| `src/unzip.js` | 极简 ZIP 读取器。NAI 返回的是 ZIP，这里用原生 `DecompressionStream` 解，不引 JSZip |
| `src/cache.js` | IndexedDB：图片（Blob）+ prompt override |
| `src/renderer.js` | slot 注入与幂等注水 |
| `src/actions.js` | 工具条与面板入口的事件委托 |
| `src/wiring.js` | SillyTavern 事件接线 |

### 两个设计约束

**1. `STREAM_TOKEN_RECEIVED` 的监听器必须同步返回。**
它在 SillyTavern 的流式循环里是被 `await` 的，任何异步等待都会直接卡住正文输出。
所以扫描是同步的，生成一律 `void pipeline.request(...)` 甩出去不等。

**2. 渲染必须幂等。**
SillyTavern 每个流式 tick 都会执行 `messageTextDom.innerHTML = formattedText`
（开了 `stream_fade_in` 则走 morphdom），默认 `streaming_fps = 30`，
也就是每秒最多把我们插进去的东西抹掉 30 次。
所以不要试图让 DOM 活下来 —— 状态全在内存里，DOM 只是它的一次投影，随时可以重画。

## License

MIT
