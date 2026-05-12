# 官方海图下载

## 运行
`node download-tiles.js` 下载全部
`node download-tiles.js id` 下载单个或多个

## QA
1. 当前保存进度是什么原理  
断点续传的原理很简单，靠文件系统本身做状态存储，没有额外的进度文件。

核心逻辑在 download-tiles.js:265-274：

// 每次下载一个瓦片前，先检查文件是否已存在且非空
const st = fs.statSync(destPath);
if (st.size > 0) {
  stats.skip++;   // 直接跳过
  return;
}
// 文件不存在 → 继续下载
具体机制：

每个瓦片对应一个固定路径 — tiles/{uid}/{z}/{x}/{y}.pbf，路径由坐标唯一决定，无歧义。

写入用临时文件 — 先写到 {y}.pbf.tmp，写完后再 renameSync 到正式路径（download-tiles.js:141-148）。这样可以保证"文件存在 = 下载完整"，不会出现半截文件被当成已完成的情况。

重启时重新遍历所有瓦片坐标 — enumerateTiles 是个生成器，按 z/x/y 顺序枚举 bounds 范围内的全部坐标。每个坐标都经过上面的 statSync 检查，已存在的直接跳过，缺失的才下载。

中断处理（SIGINT） — Ctrl+C 时设置 shuttingDown = true，并发池里正在跑的请求继续跑完，新任务不再领取（download-tiles.js:261）。下次重跑，已下载的文件都会被跳过，自然从断点继续。

优点： 无需维护额外状态文件，天然幂等，重跑安全。

代价： 每个瓦片都要做一次 statSync 系统调用，瓦片数量极大时有轻微开销，但通常可以忽略。



因为需要遍历下载的数据较多，可能很多是204的，中断后每次从头开始遍历会浪费大量时间。可否参照 /Users/hanzi/gzfs/projects/tiandiTilesDown/index.js 为每个id如3d5b1fda生成一个数据库文件，用来记录跳过和下载失败的，并且在中断时(考虑control + C 和 进程被关闭的情况)记录进度位置，下载运行从位置开始继续下载。
这是我的想法，你有什么想法和建议吗

我回答你的问题
1. 错误tile记录即可，不用马上重试，下次再次运行时 先重试错误tile，再继续下载
2. DB 放./db目录，与程序一起
3. 用
有任何问题请与我确认