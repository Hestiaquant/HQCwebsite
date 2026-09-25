/*
 * 俄羅斯方塊 規則專家基準線（arcade/policies/rule_tetris.js）
 *
 * 出處：custom_model_jev/hf_space_app/app.py 第 524 到 558 行 TETROMINOES 與第 560 到 641 行
 *   tetris_decision，逐行移植成 JavaScript；方塊表另存一份（不共用引擎的表），以保留原檔的獨立性，
 *   兩份表一致由 tools/arcade/test_engine.mjs 檢查；決策另以 tools/arcade/fixtures/rule_golden_v1.json
 *   與原檔 Python 輸出逐筆比對。
 * 這是什麼：手寫的評分規則，不是訓練出來的模型。窮舉每個旋轉與每個欄位，模擬硬落到底後的盤面，
 *   分數 = 消行數 乘 150 減 空洞數 乘 50 減 起伏度 乘 6 減 (落定列號 乘 負 2)，取最高分的落點。
 *   最後一項照抄原檔的正負號，實際效果是落得越深分數越高。
 * 與原檔不同的地方：原檔回應帶一個寫死的信心值常數與自己量的延遲，本移植兩者都不輸出；
 *   延遲由呼叫端在決策前後計時。盤面尺寸照原檔寫死 20 列、10 欄。
 * 輸入：觀測值 { piece, grid: 20 列乘 10 欄的 0 與 1, next_piece }（與原檔請求相同；next_piece 原檔未使用）。
 * 輸出：{ action: "DROP", target_col, target_rot, reason: 中文說明 }。
 * 失敗時：piece 不是字串或 grid 不是陣列時 throw TypeError；不認得的方塊種類與原檔相同改用 O。
 */
(function (root, factory) {
  "use strict";
  // [街機] 通用模組包裝：Node 走 module.exports，瀏覽器掛到 HestiaArcade.policies
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    const ns = (root.HestiaArcade = root.HestiaArcade || {});
    ns.policies = ns.policies || {};
    ns.policies[api.id] = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // [街機] 策略身分
  const ID = "rule_tetris";
  const GAME = "tetris";
  const LABEL = "規則專家基準線";

  // [街機] 方塊表（原檔第 524 到 558 行，座標為 [dx, dy]）
  const TETROMINOES = {
    I: [
      [[0, 0], [1, 0], [2, 0], [3, 0]],
      [[0, 0], [0, 1], [0, 2], [0, 3]],
    ],
    O: [[[0, 0], [1, 0], [0, 1], [1, 1]]],
    T: [
      [[0, 0], [1, 0], [2, 0], [1, 1]],
      [[1, 0], [0, 1], [1, 1], [1, 2]],
      [[1, 0], [0, 1], [1, 1], [2, 1]],
      [[0, 0], [0, 1], [1, 1], [0, 2]],
    ],
    L: [
      [[0, 0], [0, 1], [0, 2], [1, 2]],
      [[0, 0], [1, 0], [2, 0], [0, 1]],
      [[0, 0], [1, 0], [1, 1], [1, 2]],
      [[2, 0], [0, 1], [1, 1], [2, 1]],
    ],
    J: [
      [[1, 0], [1, 1], [1, 2], [0, 2]],
      [[0, 0], [0, 1], [1, 1], [2, 1]],
      [[0, 0], [1, 0], [0, 1], [0, 2]],
      [[0, 0], [1, 0], [2, 0], [2, 1]],
    ],
    S: [
      [[1, 0], [2, 0], [0, 1], [1, 1]],
      [[0, 0], [0, 1], [1, 1], [1, 2]],
    ],
    Z: [
      [[0, 0], [1, 0], [1, 1], [2, 1]],
      [[1, 0], [0, 1], [1, 1], [0, 2]],
    ],
  };

  /**
   * 規則專家決策（原檔 tetris_decision 本體，第 566 到 631 行）。
   * 輸入：觀測值，見檔頭說明。
   * 輸出：{ action: "DROP", target_col, target_rot, reason }。
   * 失敗時：piece 不是字串或 grid 不是陣列時 throw TypeError。
   */
  function decide(req) {
    if (!req || typeof req.piece !== "string" || !Array.isArray(req.grid)) {
      throw new TypeError("rule_tetris 需要字串 piece 與陣列 grid");
    }
    const pieceType = req.piece.toUpperCase();
    const variants = Object.prototype.hasOwnProperty.call(TETROMINOES, pieceType)
      ? TETROMINOES[pieceType]
      : TETROMINOES.O;
    const grid = req.grid; // 20 列乘 10 欄

    let bestScore = -999999;
    let bestCol = 3;
    let bestRot = 0;
    let bestReason = "默認落子中央";

    // [街機] 窮舉旋轉與欄位（原檔第 576 到 631 行）
    for (let rotIdx = 0; rotIdx < variants.length; rotIdx++) {
      const shape = variants[rotIdx];
      const maxDx = Math.max.apply(null, shape.map((p) => p[0]));
      // 原檔在此另算 max_dy 但沒有使用，移植時省略

      for (let col = 0; col < 10 - maxDx; col++) {
        // [街機] 硬落：逐列往下試，碰到底或方塊就停
        let dropRow = 0;
        for (;;) {
          let collided = false;
          const testR = dropRow + 1;
          for (const [dx, dy] of shape) {
            const r = testR + dy;
            const c = col + dx;
            if (r >= 20 || (r >= 0 && grid[r][c] === 1)) {
              collided = true;
              break;
            }
          }
          if (collided) break;
          dropRow = testR;
        }

        // 原檔保留的頂部溢出檢查（落定列號不會小於 0，實際上不會觸發）
        const topOverflow = shape.some((p) => dropRow + p[1] < 0);
        if (topOverflow) continue;

        // [街機] 模擬落定後的盤面
        const tempGrid = grid.map((row) => row.slice());
        for (const [dx, dy] of shape) {
          const r = dropRow + dy;
          const c = col + dx;
          if (r >= 0 && r < 20 && c >= 0 && c < 10) tempGrid[r][c] = 1;
        }

        const linesCleared = tempGrid.filter((row) => row.every((cell) => cell === 1)).length;

        // [街機] 各欄高度
        const colHeights = Array(10).fill(0);
        for (let c = 0; c < 10; c++) {
          for (let r = 0; r < 20; r++) {
            if (tempGrid[r][c] === 1) {
              colHeights[c] = 20 - r;
              break;
            }
          }
        }

        // [街機] 空洞：每欄第一個方塊以下的空格數
        let holes = 0;
        for (let c = 0; c < 10; c++) {
          let hasBlock = false;
          for (let r = 0; r < 20; r++) {
            if (tempGrid[r][c] === 1) {
              hasBlock = true;
            } else if (hasBlock && tempGrid[r][c] === 0) {
              holes += 1;
            }
          }
        }

        let bumpiness = 0;
        for (let c = 0; c < 9; c++) bumpiness += Math.abs(colHeights[c] - colHeights[c + 1]);

        // [街機] 評分公式照抄原檔第 625 行，含最後一項的正負號
        const score = linesCleared * 150 - holes * 50 - bumpiness * 6 - dropRow * -2;

        if (score > bestScore) {
          bestScore = score;
          bestCol = col;
          bestRot = rotIdx;
          bestReason =
            "瞄準第 " + col + " 欄 (旋轉 " + rotIdx + ")：預期消行 " + linesCleared +
            "，空洞風險 " + holes + "，起伏度 " + bumpiness;
        }
      }
    }

    return { action: "DROP", target_col: bestCol, target_rot: bestRot, reason: bestReason };
  }

  return { id: ID, game: GAME, label: LABEL, TETROMINOES, decide };
});
