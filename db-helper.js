'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class TileProgressDB {
  constructor(dbDir, uid) {
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, `${uid}.db`);
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._init();
    this._prepare();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS completed_batches (
        z INTEGER NOT NULL,
        x INTEGER NOT NULL,
        PRIMARY KEY (z, x)
      );
      CREATE TABLE IF NOT EXISTS error_tiles (
        z INTEGER NOT NULL,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        PRIMARY KEY (z, x, y)
      );
    `);
  }

  _prepare() {
    this.stmtIsBatchDone  = this.db.prepare('SELECT 1 FROM completed_batches WHERE z=? AND x=?');
    this.stmtMarkDone     = this.db.prepare('INSERT OR IGNORE INTO completed_batches(z,x) VALUES(?,?)');
    this.stmtGetErrors    = this.db.prepare('SELECT z,x,y FROM error_tiles');
    this.stmtCountErrors  = this.db.prepare('SELECT COUNT(*) AS cnt FROM error_tiles');
    this.stmtAddError     = this.db.prepare('INSERT OR IGNORE INTO error_tiles(z,x,y) VALUES(?,?,?)');
    this.stmtRemoveError  = this.db.prepare('DELETE FROM error_tiles WHERE z=? AND x=? AND y=?');
    this.stmtCountBatches = this.db.prepare('SELECT COUNT(*) AS cnt FROM completed_batches');
  }

  isBatchDone(z, x) {
    return !!this.stmtIsBatchDone.get(z, x);
  }

  markBatchDone(z, x) {
    this.stmtMarkDone.run(z, x);
  }

  getErrorTiles() {
    return this.stmtGetErrors.all();
  }

  errorCount() {
    return this.stmtCountErrors.get().cnt;
  }

  completedBatchCount() {
    return this.stmtCountBatches.get().cnt;
  }

  addError(z, x, y) {
    this.stmtAddError.run(z, x, y);
  }

  removeError(z, x, y) {
    this.stmtRemoveError.run(z, x, y);
  }

  close() {
    try { this.db.close(); } catch (_) {}
  }
}

module.exports = TileProgressDB;
