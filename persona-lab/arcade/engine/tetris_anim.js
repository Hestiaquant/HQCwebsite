/*
 * 俄羅斯方塊落下動畫的路徑規劃（arcade/engine/tetris_anim.js）
 *
 * 做什麼：LEE 2026-09-26 回報方塊直接出現在落點，經典呈現應是從上方落下。本模組只算畫面上每一格的位置，
 *   不改遊戲規則：策略在方塊出現時算一次決策，引擎 applyDecision 仍是從第 0 列直接硬落到底；
 *   這裡把同一個決策拆成一串畫格：新方塊在盤面頂端的生成位置出現（第 0 列、置中、旋轉 0），
 *   先一格一格旋轉到決策的方向，再一欄一欄水平移到目標欄，最後一列一列往下落到引擎算出的落定列。
 *   最後一格一定等於 applyDecision 的落點（同一個 landingRow）。不碰 DOM、不用 Math.random，瀏覽器與 Node 共用。
 * 輸入：planDrop(grid, piece, decision, options)
 *   grid：20 列乘 10 欄的 0 與 1（引擎狀態的 grid，本函式不修改它）；piece：I、O、T、L、J、S、Z；
 *   decision：{ target_col, target_rot }；options：{ rowsPerFrame（每格往下幾列，預設 1）、
 *   moveInOneFrame（旋轉與水平移動壓成一格，預設 false）、instant（只給落點一格，預設 false） }。
 * 輸出：畫格陣列 [{ rot, col, row }, ...]，row 是形狀原點所在列，與引擎的座標定義相同。
 * 失敗時：方塊種類不認得或決策不合法時 throw RangeError（呼叫端應先用引擎的 isLegalDecision 檢查）；
 *   rowsPerFrame 不是正整數時 throw RangeError。
 */
(function (root, factory) {
  "use strict";
  // [街機] 通用模組包裝：Node 走 module.exports（自行 require 引擎），瀏覽器掛到 HestiaArcade.tetrisAnim（引擎要先載入）
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./tetris.js"));
  } else {
    const ns = (root.HestiaArcade = root.HestiaArcade || {});
    ns.tetrisAnim = factory(ns.tetris);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (tetris) {
  "use strict";

  if (!tetris || !tetris.PIECES) {
    throw new TypeError("tetris_anim.js 需要先載入 engine/tetris.js");
  }
  const COLS = tetris.COLS;

  /**
   * 某個旋轉形狀水平方向的最大位移。
   * 輸入：形狀（[dx, dy] 陣列）。輸出：最大 dx。
   */
  function maxDx(shape) {
    return Math.max.apply(null, shape.map((p) => p[0]));
  }

  /**
   * 新方塊的生成欄位：旋轉 0 的形狀在 10 欄中置中（寬 4 的 I 在第 3 欄，寬 3 在第 3 欄，寬 2 的 O 在第 4 欄）。
   * 輸入：方塊種類。輸出：欄位整數。
   * 失敗時：不認得的方塊種類 throw RangeError。
   */
  function spawnCol(piece) {
    const variants = tetris.PIECES[piece];
    if (!variants) throw new RangeError("不認得的方塊種類：" + piece);
    const width = maxDx(variants[0]) + 1;
    return Math.floor((COLS - width) / 2);
  }

  /**
   * 規劃一個方塊從生成位置到落點的畫格。
   * 輸入、輸出與失敗時：見檔頭。
   */
  function planDrop(grid, piece, decision, options) {
    const opts = options || {};
    const rowsPerFrame = opts.rowsPerFrame === undefined ? 1 : opts.rowsPerFrame;
    if (!Number.isInteger(rowsPerFrame) || rowsPerFrame < 1) {
      throw new RangeError("rowsPerFrame 必須是正整數");
    }
    const variants = tetris.PIECES[piece];
    if (!variants) throw new RangeError("不認得的方塊種類：" + piece);
    if (!tetris.isLegalDecision({ current: piece }, decision)) {
      throw new RangeError("決策不合法，無法規劃落下路徑");
    }
    const targetRot = decision.target_rot;
    const targetCol = decision.target_col;
    const landing = tetris.landingRow(grid, variants[targetRot], targetCol);
    const final = { rot: targetRot, col: targetCol, row: landing };
    if (opts.instant) return [final];

    // [街機] 第 1 格：生成位置（第 0 列、置中、旋轉 0）
    const frames = [];
    let rot = 0;
    let col = spawnCol(piece);
    frames.push({ rot: rot, col: col, row: 0 });

    // [街機] 在第 0 列旋轉與水平移動
    if (opts.moveInOneFrame) {
      if (rot !== targetRot || col !== targetCol) {
        rot = targetRot;
        col = targetCol;
        frames.push({ rot: rot, col: col, row: 0 });
      }
    } else {
      while (rot < targetRot) {
        rot += 1;
        // 旋轉後形狀變寬時往左收，確保整個方塊留在盤面內
        col = Math.min(col, COLS - 1 - maxDx(variants[rot]));
        frames.push({ rot: rot, col: col, row: 0 });
      }
      while (col !== targetCol) {
        col += col < targetCol ? 1 : -1;
        frames.push({ rot: rot, col: col, row: 0 });
      }
    }

    // [街機] 往下落到落定列；每格下降 rowsPerFrame 列，最後一格剛好停在落定列
    let row = 0;
    while (row < landing) {
      row = Math.min(row + rowsPerFrame, landing);
      frames.push({ rot: rot, col: col, row: row });
    }
    return frames;
  }

  return {
    spawnCol,
    planDrop,
  };
});
