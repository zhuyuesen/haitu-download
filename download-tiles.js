#!/usr/bin/env node
/**
 * 批量下载海图 PBF 矢量瓦片
 *
 * 特性：
 *   - 自动读取 ./configs 下所有 UUID 命名的 JSON 配置
 *   - 断点续传：已完成的 (z,x) 列批次记录到 SQLite，下次直接跳过
 *   - 204 / 404 → 跳过（不保存），整列完成后记录，下次不再重复请求
 *   - 网络错误记录到 DB，下次运行优先重试，再继续正常下载
 *   - 中断安全：SIGINT / SIGTERM / SIGHUP 均可优雅退出并保存进度
 *   - 并发下载，实时进度显示
 *
 * 用法：
 *   node download-tiles.js                  # 下载全部数据集
 *   node download-tiles.js 521839b4         # 只下载 uid 以此前缀开头的数据集
 *   node download-tiles.js 521839b4 3d5b1fda  # 下载多个前缀（空格分隔）
 * 推荐单个下载, 全部id为: 3d5b1fda 4a774395 4cf48c67-c38f 90aab3df 345f6de2 521839b4
 */

'use strict';

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const TileProgressDB = require('./db-helper');

// ===================== 配置 =====================

/**
 * 目录配置:
 * 方式1：反斜杠全部转义
const OUTPUT_DIR = "D:\\map\\world";
方式2：用正斜杠（Node.js 在 Windows 下同样支持）
const OUTPUT_DIR = "D:/map/world";
方式3：用 path.join 拼接，避免手写分隔符
const OUTPUT_DIR = path.join("D:\\", "map", "world");
 */

const CONFIGS_DIR = path.resolve(__dirname, "./configs");
const OUTPUT_DIR = path.resolve(__dirname, "./tiles");
const DB_DIR = path.resolve(__dirname, "./db");
const MAX_ZOOM_CAP = 18;
const CONCURRENCY = 50;
const RETRY_LIMIT = 3;
const RETRY_DELAY_MS = 1500;
const REQUEST_TIMEOUT_MS = 30000;
const PROGRESS_EVERY_MS = 300;
// ================================================

// -------- 全局退出控制 --------

let shuttingDown = false;
let sigintCount = 0;

process.on('SIGINT', () => {
  sigintCount++;
  if (sigintCount >= 2) {
    console.log('\n强制退出');
    process.exit(1);
  }
  console.log('\n收到 Ctrl+C，完成当前列批次后退出（再按一次强制退出）');
  shuttingDown = true;
});
process.on('SIGTERM', () => { console.log('\n收到 SIGTERM，正在退出...'); shuttingDown = true; });
process.on('SIGHUP', () => { console.log('\n收到 SIGHUP，正在退出...'); shuttingDown = true; });

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
      const raw = JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, f), "utf-8"));
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

// -------- 瓦片计数 --------

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
          try { fs.unlinkSync(tmp); } catch (_) { }
          reject(e);
        });
        return;
      }

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

// -------- 并发池 --------

async function runWithConcurrency(iter, concurrency, workerFn, shouldStop = null) {
  async function runOne() {
    while (true) {
      if (shouldStop?.()) return;
      const { value, done } = iter.next();
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

// -------- y 列生成器 --------

function* yRange(yMin, yMax) {
  for (let y = yMin; y <= yMax; y++) yield y;
}

// -------- 单数据集下载 --------

async function downloadDataset(config) {
  const { uid, name, tiles, minzoom, maxzoom, bounds } = config;
  const [west, south, east, north] = bounds;
  const tileUrlTemplate = tiles[0];
  const outDir = path.join(OUTPUT_DIR, uid);
  const totalBbox = countTiles(config);

  console.log(`\n▶  ${name}`);
  console.log(`   uid: ${uid}`);
  console.log(`   zoom ${minzoom}–${maxzoom}  包围框瓦片坐标数: ${fmtNum(totalBbox)}`);
  console.log(`   输出: ${outDir}`);

  const db = new TileProgressDB(DB_DIR, uid);
  console.log(`   进度DB: ${path.join(DB_DIR, uid + '.db')}  已完成批次: ${fmtNum(db.completedBatchCount())}  历史错误: ${db.errorCount()}`);

  // ---- Phase 1：重试历史错误 tile ----

  const errorTiles = db.getErrorTiles();
  let retryOk = 0, retrySkip = 0, retryFail = 0;

  if (errorTiles.length > 0 && !shuttingDown) {
    console.log(`\n   [Phase 1] 重试 ${errorTiles.length} 个历史错误瓦片...`);
    let retried = 0;
    const retryIter = errorTiles[Symbol.iterator]();

    await runWithConcurrency(retryIter, CONCURRENCY, async ({ z, x, y }) => {
      if (shuttingDown) return;
      const destPath = path.join(outDir, String(z), String(x), `${y}.pbf`);
      const url = tileUrlTemplate.replace("{z}", z).replace("{x}", x).replace("{y}", y);
      try {
        const result = await downloadTile(url, destPath, RETRY_LIMIT);
        db.removeError(z, x, y);
        result.status === "ok" ? retryOk++ : retrySkip++;
      } catch (_) {
        retryFail++;
      }
      retried++;
      process.stdout.write(
        `\r   重试: ${retried}/${errorTiles.length}  成功:${retryOk}  空瓦片:${retrySkip}  仍失败:${retryFail}   `
      );
    }, () => shuttingDown);

    console.log(`\n   Phase 1 完成：解决 ${retryOk + retrySkip} 个，仍失败 ${db.errorCount()} 个`);
  }

  // 将本次重试后仍失败的 tile 放入 Set，Phase 2 中跳过（本次不再重复尝试）
  const stillErrorSet = new Set(
    db.getErrorTiles().map(({ z, x, y }) => `${z}:${x}:${y}`)
  );

  // ---- Phase 2：按 (z, x) 列批次正常下载 ----

  if (errorTiles.length > 0 && !shuttingDown) {
    console.log('   [Phase 2] 继续正常下载...');
  }

  const stats = { ok: 0, skip: 0, error: 0, processed: 0 };
  const startTime = Date.now();
  let lastPrint = 0;

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

  for (let z = minzoom; z <= maxzoom && !shuttingDown; z++) {
    const xMin = lngToTileX(west, z);
    const xMax = lngToTileX(east, z);
    const yMin = latToTileY(north, z);
    const yMax = latToTileY(south, z);
    const colHeight = yMax - yMin + 1;

    for (let x = xMin; x <= xMax && !shuttingDown; x++) {

      // 已完成的列批次直接跳过
      if (db.isBatchDone(z, x)) {
        stats.skip += colHeight;
        stats.processed += colHeight;
        printProgress();
        continue;
      }

      await runWithConcurrency(yRange(yMin, yMax), CONCURRENCY, async (y) => {
        if (shuttingDown) return;

        // Phase 1 重试后仍失败的，本次跳过
        if (stillErrorSet.has(`${z}:${x}:${y}`)) {
          stats.error++;
          stats.processed++;
          printProgress();
          return;
        }

        const destPath = path.join(outDir, String(z), String(x), `${y}.pbf`);

        // 文件已存在（非空）跳过
        try {
          if (fs.statSync(destPath).size > 0) {
            stats.skip++;
            stats.processed++;
            printProgress();
            return;
          }
        } catch (_) { }

        const url = tileUrlTemplate.replace("{z}", z).replace("{x}", x).replace("{y}", y);
        try {
          const result = await downloadTile(url, destPath, RETRY_LIMIT);
          result.status === "ok" ? stats.ok++ : stats.skip++;
        } catch (_) {
          stats.error++;
          db.addError(z, x, y);
        }
        stats.processed++;
        printProgress();
      }, () => shuttingDown);

      // 未中断时标记整列完成
      if (!shuttingDown) {
        db.markBatchDone(z, x);
      }
    }
  }

  printProgress(true);
  console.log();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `   ✓ 完成: 有效瓦片 ${fmtNum(stats.ok + retryOk)}，` +
    `跳过(含续传/空) ${fmtNum(stats.skip + retrySkip)}，` +
    `错误 ${stats.error + retryFail}，耗时 ${elapsed}s`
  );

  if (shuttingDown) {
    console.log("   ⚠ 已中断，下次运行将从断点继续");
  }

  db.close();

  return {
    ok: stats.ok + retryOk,
    skip: stats.skip + retrySkip,
    error: stats.error + retryFail,
  };
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
  console.log(`进度DB目录: ${DB_DIR}`);
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
  fs.mkdirSync(DB_DIR, { recursive: true });

  const summary = {};

  for (const config of configs) {
    if (shuttingDown) break;
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
