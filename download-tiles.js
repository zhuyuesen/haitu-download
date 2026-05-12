#!/usr/bin/env node
/**
 * 批量下载海图 PBF 矢量瓦片
 *
 * 特性：
 *   - 自动读取 ./configs 下所有 UUID 命名的 JSON 配置
 *   - 断点续传：已存在文件自动跳过
 *   - 204 / 404 → 跳过（不保存），不计为错误
 *   - 网络错误自动重试
 *   - maxzoom 超过 18 时统一截断到 18
 *   - 并发下载，实时进度显示
 *
 * 用法：
 *   node download-tiles.js                  # 下载全部数据集
 *   node download-tiles.js 521839b4         # 只下载 uid 以此前缀开头的数据集
 *   node download-tiles.js 521839b4 3d5b1fda  # 下载多个前缀（空格分隔）
 * 推荐单个下载, 全部id为: 3d5b1fda 4a774395 4cf48c67-c38f 90aab3df 345f6de2 521839b4
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ===================== 配置 =====================
const CONFIGS_DIR = path.resolve(__dirname, "./configs");
const OUTPUT_DIR = path.resolve(__dirname, "./tiles");
const MAX_ZOOM_CAP = 18;    // zoom 上限，超出截断
const CONCURRENCY = 8;     // 并发请求数（可调高，多数是快速 204）
const RETRY_LIMIT = 3;     // 网络错误重试次数
const RETRY_DELAY_MS = 1500;  // 重试间隔（毫秒）
const REQUEST_TIMEOUT_MS = 30000; // 单个请求超时（毫秒）
const PROGRESS_EVERY_MS = 300;   // 进度刷新间隔
// ================================================

// -------- 坐标转换 --------

function lngToTileX(lng, z) {
  return Math.floor(((lng + 180) / 360) * Math.pow(2, z));
}

function latToTileY(lat, z) {
  lat = Math.max(-85.051129, Math.min(85.051129, lat));
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
    Math.pow(2, z)
  );
}

// -------- 配置加载 --------

function loadConfigs(filterPrefixes) {
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

  const files = fs.readdirSync(CONFIGS_DIR).filter((f) => UUID_RE.test(f));
  if (files.length === 0) {
    throw new Error(`CONFIGS_DIR 下未找到 UUID JSON 文件: ${CONFIGS_DIR}`);
  }

  return files
    .map((f) => {
      const raw = JSON.parse(
        fs.readFileSync(path.join(CONFIGS_DIR, f), "utf-8")
      );
      return { _file: f, ...raw };
    })
    .filter((d) => Array.isArray(d.tiles) && d.tiles.length > 0)
    .filter((d) => {
      if (!filterPrefixes || filterPrefixes.length === 0) return true;
      const uid = d.uid || path.basename(d._file, ".json");
      return filterPrefixes.some((p) => uid.startsWith(p));
    })
    .map((d) => ({
      uid: d.uid || path.basename(d._file, ".json"),
      name: d.name || d.uid,
      tiles: d.tiles,
      bounds: d.bounds,
      minzoom: d.minzoom,
      maxzoom: Math.min(d.maxzoom, MAX_ZOOM_CAP),
    }));
}

// -------- 瓦片枚举（惰性生成器，不占内存） --------

function* enumerateTiles(config) {
  const [west, south, east, north] = config.bounds;
  for (let z = config.minzoom; z <= config.maxzoom; z++) {
    const xMin = lngToTileX(west, z);
    const xMax = lngToTileX(east, z);
    const yMin = latToTileY(north, z); // 纬度大 → y 小
    const yMax = latToTileY(south, z);
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        yield { z, x, y };
      }
    }
  }
}

function countTiles(config) {
  const [west, south, east, north] = config.bounds;
  let total = 0;
  for (let z = config.minzoom; z <= config.maxzoom; z++) {
    const xw = lngToTileX(east, z) - lngToTileX(west, z) + 1;
    const yh = latToTileY(south, z) - latToTileY(north, z) + 1;
    total += xw * yh;
  }
  return total;
}

// -------- HTTP 下载 --------

function downloadTile(url, destPath, retriesLeft) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { rejectUnauthorized: false }, (res) => {
      const { statusCode } = res;

      // 204 No Content 或 404：该坐标无瓦片，跳过
      if (statusCode === 204 || statusCode === 404) {
        res.resume();
        return resolve({ status: "skip", code: statusCode });
      }

      if (statusCode === 200) {
        const tmp = destPath + ".tmp";
        const file = fs.createWriteStream(tmp);
        res.pipe(file);
        file.on("finish", () =>
          file.close(() => {
            try {
              fs.renameSync(tmp, destPath);
              resolve({ status: "ok" });
            } catch (e) {
              reject(e);
            }
          })
        );
        file.on("error", (e) => {
          try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
          reject(e);
        });
        return;
      }

      // 其他状态码视为可重试错误
      res.resume();
      const err = new Error(`HTTP ${statusCode}`);
      if (retriesLeft > 0) {
        setTimeout(
          () => downloadTile(url, destPath, retriesLeft - 1).then(resolve).catch(reject),
          RETRY_DELAY_MS
        );
      } else {
        reject(err);
      }
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("timeout")));

    req.on("error", (err) => {
      if (retriesLeft > 0) {
        setTimeout(
          () => downloadTile(url, destPath, retriesLeft - 1).then(resolve).catch(reject),
          RETRY_DELAY_MS
        );
      } else {
        reject(err);
      }
    });
  });
}

// -------- 并发池（基于生成器，O(1) 内存） --------

async function runWithConcurrency(gen, concurrency, workerFn) {
  // JS 单线程，gen.next() 调用之间不会有竞态
  async function runOne() {
    while (true) {
      const { value, done } = gen.next();
      if (done) return;
      await workerFn(value);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runOne));
}

// -------- 进度格式化 --------

function fmtEta(sec) {
  if (sec <= 0 || !isFinite(sec)) return "--";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

function fmtNum(n) {
  return n.toLocaleString("en-US");
}

// -------- 单数据集下载 --------

async function downloadDataset(config) {
  const { uid, name, tiles, minzoom, maxzoom } = config;
  const tileUrlTemplate = tiles[0];
  const outDir = path.join(OUTPUT_DIR, uid);
  const totalBbox = countTiles(config);

  console.log(`\n▶  ${name}`);
  console.log(`   uid: ${uid}`);
  console.log(`   zoom ${minzoom}–${maxzoom}  包围框瓦片坐标数: ${fmtNum(totalBbox)}`);
  console.log(`   输出: ${outDir}`);

  const stats = { ok: 0, skip: 0, error: 0, processed: 0 };
  const startTime = Date.now();
  let lastPrint = 0;
  let shuttingDown = false;

  const printProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastPrint < PROGRESS_EVERY_MS) return;
    lastPrint = now;

    const elapsed = (now - startTime) / 1000;
    const rate = elapsed > 0 ? stats.processed / elapsed : 0;
    const remaining = totalBbox - stats.processed;
    const etaSec = rate > 0 ? Math.round(remaining / rate) : Infinity;
    const pct = totalBbox > 0
      ? ((stats.processed / totalBbox) * 100).toFixed(1)
      : "0.0";

    process.stdout.write(
      `\r   ${pct}% [${fmtNum(stats.processed)}/${fmtNum(totalBbox)}] ` +
      `下载:${fmtNum(stats.ok)} 跳过:${fmtNum(stats.skip)} 错误:${stats.error} ` +
      `速率:${rate.toFixed(0)}/s ETA:${fmtEta(etaSec)}    `
    );
  };

  // SIGINT：本次数据集停止，下次从断点继续
  const onSigint = () => { shuttingDown = true; };
  process.on("SIGINT", onSigint);

  const gen = enumerateTiles(config);

  await runWithConcurrency(gen, CONCURRENCY, async ({ z, x, y }) => {
    if (shuttingDown) return;

    const destPath = path.join(outDir, String(z), String(x), `${y}.pbf`);

    // 断点续传：非空文件直接跳过
    try {
      const st = fs.statSync(destPath);
      if (st.size > 0) {
        stats.skip++;
        stats.processed++;
        printProgress();
        return;
      }
    } catch (_) { /* 文件不存在，继续下载 */ }

    const url = tileUrlTemplate
      .replace("{z}", z)
      .replace("{x}", x)
      .replace("{y}", y);

    try {
      const result = await downloadTile(url, destPath, RETRY_LIMIT);
      result.status === "ok" ? stats.ok++ : stats.skip++;
    } catch (e) {
      stats.error++;
    }
    stats.processed++;
    printProgress();
  });

  process.off("SIGINT", onSigint);
  printProgress(true);
  console.log(); // 换行

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `   ✓ 完成: 有效瓦片 ${fmtNum(stats.ok)}，` +
    `跳过(含续传) ${fmtNum(stats.skip)}，` +
    `错误 ${stats.error}，耗时 ${elapsed}s`
  );

  if (shuttingDown) {
    console.log("   ⚠ 已中断，下次运行将从断点继续");
  }

  return stats;
}

// -------- 主入口 --------

async function main() {
  const filterPrefixes = process.argv.slice(2);

  const configs = loadConfigs(filterPrefixes.length > 0 ? filterPrefixes : null);

  if (configs.length === 0) {
    console.error(
      `未找到匹配的数据集（前缀过滤: ${filterPrefixes.join(", ") || "无"}）`
    );
    process.exit(1);
  }

  console.log("======================================");
  console.log(" 海图 PBF 瓦片批量下载");
  console.log("======================================");
  console.log(`数据集数量: ${configs.length}`);
  console.log(`输出根目录: ${OUTPUT_DIR}`);
  console.log(`并发数:     ${CONCURRENCY}`);
  console.log(`zoom 上限:  ${MAX_ZOOM_CAP}`);
  console.log();

  configs.forEach((c) => {
    const total = countTiles(c);
    console.log(
      `  [${c.uid.substring(0, 8)}] ${c.name}  zoom:${c.minzoom}-${c.maxzoom}  ~${fmtNum(total)} 坐标`
    );
  });

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const summary = {};
  let sigintCount = 0;

  process.on("SIGINT", () => {
    sigintCount++;
    if (sigintCount >= 2) {
      console.log("\n强制退出");
      process.exit(1);
    }
    console.log("\n收到 Ctrl+C，当前数据集完成后停止（再按一次强制退出）");
  });

  for (const config of configs) {
    summary[config.uid] = await downloadDataset(config);
  }

  console.log("\n========== 总计 ==========");
  let totalOk = 0, totalSkip = 0, totalError = 0;
  for (const [uid, s] of Object.entries(summary)) {
    const cfg = configs.find((c) => c.uid === uid);
    console.log(
      `  ${uid.substring(0, 8)}  ${cfg ? cfg.name : ""}` +
      `  下载:${fmtNum(s.ok)} 跳过:${fmtNum(s.skip)} 错误:${s.error}`
    );
    totalOk += s.ok;
    totalSkip += s.skip;
    totalError += s.error;
  }
  console.log(`\n  有效瓦片合计: ${fmtNum(totalOk)}`);
  console.log(`  跳过合计:     ${fmtNum(totalSkip)}`);
  console.log(`  错误合计:     ${totalError}`);
}

main().catch((err) => {
  console.error("\nFatal:", err.message);
  process.exit(1);
});
