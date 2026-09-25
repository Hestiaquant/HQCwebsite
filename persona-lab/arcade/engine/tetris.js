/*
 * 俄羅斯方塊遊戲引擎（arcade/engine/tetris.js）
 *
 * 做什麼：從原版街機頁 arcade.html 抽出俄羅斯方塊的遊戲規則（原檔第 967 到 979 行的盤面與七種方塊、
 *   第 998 到 1001 行的抽方塊、第 1152 到 1207 行的落子、消行、頂出判定與輪替、
 *   第 1229 到 1241 行的開局狀態），改寫成不碰 DOM 的純邏輯模組，瀏覽器與 Node 共用。
 * 與原版相同的規則：20 列乘 10 欄；每回合策略選定欄位與旋轉，方塊從第 0 列直接硬落到底；
 *   落定後由下往上消除滿列；第 0 列有任何方塊就結束（頂出）；否則下一塊變成目前方塊，再抽新的下一塊。
 * 與原版不同的地方（都為了公平比較與可重現）：
 *   1. 亂數由呼叫端注入，不用 Math.random，同種子同局面（同一串方塊）。
 *   2. 欄位或旋轉超出範圍時判為非法動作並結束該局（原版會悄悄改用旋轉 0，欄位越界的格子直接消失）。
 * 輸入：createGame({ rng }) 的 rng 為回傳 [0,1) 的函式；applyDecision 的決策物件 { target_col, target_rot }
 *   （沿用原版後端回應的欄位名）。
 * 輸出：遊戲狀態物件；observe 回傳與原版後端請求同形狀的觀測值。
 * 失敗時：rng 不是函式 throw TypeError；對已結束的局面再下決策 throw Error。
 */
(function (root, factory) {
  "use strict";
  // [街機] 通用模組包裝：Node 走 module.exports，瀏覽器掛到 HestiaArcade 命名空間
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    const ns = (root.HestiaArcade = root.HestiaArcade || {});
    ns.tetris = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // [街機] 常數與七種方塊（照抄原版 arcade.html 第 967 到 979 行，座標為 [dx, dy]）
  const GAME_ID = "tetris";
  const ROWS = 20;
  const COLS = 10;
  const PIECES = {
    I: [[[0, 0], [1, 0], [2, 0], [3, 0]], [[0, 0], [0, 1], [0, 2], [0, 3]]],
    O: [[[0, 0], [1, 0], [0, 1], [1, 1]]],
    T: [[[0, 0], [1, 0], [2, 0], [1, 1]], [[1, 0], [0, 1], [1, 1], [1, 2]], [[1, 0], [0, 1], [1, 1], [2, 1]], [[0, 0], [0, 1], [1, 1], [0, 2]]],
    L: [[[0, 0], [0, 1], [0, 2], [1, 2]], [[0, 0], [1, 0], [2, 0], [0, 1]], [[0, 0], [1, 0], [1, 1], [1, 2]], [[2, 0], [0, 1], [1, 1], [2, 1]]],
    J: [[[1, 0], [1, 1], [1, 2], [0, 2]], [[0, 0], [0, 1], [1, 1], [2, 1]], [[0, 0], [1, 0], [0, 1], [0, 2]], [[0, 0], [1, 0], [2, 0], [2, 1]]],
    S: [[[1, 0], [2, 0], [0, 1], [1, 1]], [[0, 0], [0, 1], [1, 1], [1, 2]]],
    Z: [[[0, 0], [1, 0], [1, 1], [2, 1]], [[1, 0], [0, 1], [1, 1], [0, 2]]],
  };
  const PIECE_KEYS = Object.keys(PIECES); // I、O、T、L、J、S、Z，與原版 Object.keys 順序相同

  // [街機] 結束原因代碼
  const END_REASONS = {
    TOP_OUT: "top_out",
    ILLEGAL: "illegal_action",
  };

  /**
   * 建立全空的盤面。
   * 輸入：每格的初始值（數字 0 或 null）。
   * 輸出：20 列乘 10 欄的二維陣列。
   */
  function emptyGrid(fill) {
    return Array.from({ length: ROWS }, () => Array(COLS).fill(fill));
  }

  /**
   * 用注入的亂數抽一個方塊種類（原版 getRandomPiece，第 998 到 1001 行）。
   * 輸入：亂數函式。
   * 輸出：I、O、T、L、J、S、Z 其中之一。
   * 失敗時：亂數函式出錯時錯誤直接往上拋。
   */
  function randomPiece(rng) {
    return PIECE_KEYS[Math.floor(rng() * PIECE_KEYS.length)];
  }

  /**
   * 建立一局新遊戲（對應原版 resetTetrisGame，第 1229 到 1241 行：先抽目前方塊，再抽下一塊）。
   * 輸入：options.rng，回傳 [0,1) 的亂數函式。
   * 輸出：遊戲狀態 { grid（0 與 1）, cells（每格的方塊種類，畫色用）, current, next, lines, pieces, over, endReason, rng }。
   * 失敗時：rng 不是函式 throw TypeError。
   */
  function createGame(options) {
    const rng = options && options.rng;
    if (typeof rng !== "function") {
      throw new TypeError("createGame 需要注入亂數函式 options.rng");
    }
    const current = randomPiece(rng);
    const next = randomPiece(rng);
    return {
      game: GAME_ID,
      grid: emptyGrid(0),
      cells: emptyGrid(null),
      current: current,
      next: next,
      lines: 0,
      pieces: 0,
      over: false,
      endReason: null,
      rng: rng,
    };
  }

  /**
   * 方塊某個旋轉形狀在水平方向佔用的最大位移。
   * 輸入：形狀（[dx, dy] 陣列）。
   * 輸出：最大 dx。
   */
  function maxDx(shape) {
    return Math.max.apply(null, shape.map((p) => p[0]));
  }

  /**
   * 算方塊從第 0 列硬落後停在哪一列（原版第 1156 到 1170 行的落子迴圈，逐列往下試，碰到底或方塊就停）。
   * 輸入：盤面（0 與 1）、形狀、起始欄位。
   * 輸出：落定時形狀原點所在的列號（0 以上）。
   * 失敗時：不 throw；欄位合法性由呼叫端先檢查。
   */
  function landingRow(grid, shape, col) {
    let dropR = 0;
    for (;;) {
      let collided = false;
      const testR = dropR + 1;
      for (const [dx, dy] of shape) {
        const r = testR + dy;
        const c = col + dx;
        if (r >= ROWS || (r >= 0 && grid[r][c] === 1)) {
          collided = true;
          break;
        }
      }
      if (collided) break;
      dropR = testR;
    }
    return dropR;
  }

  /**
   * 判斷策略輸出的決策物件在目前局面是否合法。
   * 輸入：遊戲狀態、決策物件 { target_col, target_rot }。
   * 輸出：旋轉編號在該方塊的形狀數以內、欄位讓整個方塊留在盤面內時回 true，否則回 false；不會 throw。
   */
  function isLegalDecision(state, decision) {
    if (!decision || typeof decision !== "object") return false;
    const variants = PIECES[state.current];
    const rot = decision.target_rot;
    const col = decision.target_col;
    if (!Number.isInteger(rot) || rot < 0 || rot >= variants.length) return false;
    if (!Number.isInteger(col) || col < 0) return false;
    return col <= COLS - 1 - maxDx(variants[rot]);
  }

  /**
   * 列出目前方塊所有合法的落點（依旋轉再依欄位的順序）。
   * 輸入：遊戲狀態。
   * 輸出：決策物件陣列 [{ target_col, target_rot }, ...]。
   */
  function legalActions(state) {
    const out = [];
    const variants = PIECES[state.current];
    for (let rot = 0; rot < variants.length; rot++) {
      const limit = COLS - 1 - maxDx(variants[rot]);
      for (let col = 0; col <= limit; col++) {
        out.push({ target_col: col, target_rot: rot });
      }
    }
    return out;
  }

  /**
   * 依決策落下目前方塊並推進一回合（原版 stepTetris 的落子到輪替段，第 1152 到 1207 行）。
   * 輸入：遊戲狀態（就地修改）、決策物件 { target_col, target_rot }。
   * 輸出：{ cleared, row, over, endReason }；cleared 為本回合消除的列數，row 為落定列號。
   * 失敗時：對已結束的局面呼叫 throw Error；非法決策不 throw，改為結束該局並標 illegal_action。
   */
  function applyDecision(state, decision) {
    if (state.over) {
      throw new Error("這一局已經結束，不能再下決策");
    }
    if (!isLegalDecision(state, decision)) {
      state.over = true;
      state.endReason = END_REASONS.ILLEGAL;
      return { cleared: 0, row: null, over: true, endReason: END_REASONS.ILLEGAL };
    }
    const piece = state.current;
    const shape = PIECES[piece][decision.target_rot];
    const col = decision.target_col;
    const dropR = landingRow(state.grid, shape, col);

    // [街機] 落定方塊
    for (const [dx, dy] of shape) {
      const r = dropR + dy;
      const c = col + dx;
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
        state.grid[r][c] = 1;
        state.cells[r][c] = piece;
      }
    }
    state.pieces += 1;

    // [街機] 消除滿列：與原版相同由下往上掃，消掉一列後同一列號再檢查一次
    let cleared = 0;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (state.grid[r].every((v) => v === 1)) {
        state.grid.splice(r, 1);
        state.cells.splice(r, 1);
        state.grid.unshift(Array(COLS).fill(0));
        state.cells.unshift(Array(COLS).fill(null));
        cleared += 1;
        r += 1;
      }
    }
    state.lines += cleared;

    // [街機] 頂出判定：第 0 列有方塊就結束，不再輪替
    if (state.grid[0].some((v) => v === 1)) {
      state.over = true;
      state.endReason = END_REASONS.TOP_OUT;
      return { cleared: cleared, row: dropR, over: true, endReason: END_REASONS.TOP_OUT };
    }

    // [街機] 輪替：下一塊變目前方塊，再抽新的下一塊
    state.current = state.next;
    state.next = randomPiece(state.rng);
    return { cleared: cleared, row: dropR, over: false, endReason: null };
  }

  /**
   * 產生給策略看的觀測值，形狀與原版後端 /decision/tetris 的請求相同。
   * 輸入：遊戲狀態。
   * 輸出：{ piece, grid（複本）, next_piece }，策略改動它不會影響遊戲狀態。
   */
  function observe(state) {
    return {
      piece: state.current,
      grid: state.grid.map((row) => row.slice()),
      next_piece: state.next,
    };
  }

  /**
   * 整理一局的成績，給對局器與展示頁的統計表用。
   * 輸入：遊戲狀態。
   * 輸出：{ score, steps, lines, pieces }；score 定義為消除列數，steps 定義為已擺放方塊數。
   */
  function result(state) {
    return {
      score: state.lines,
      steps: state.pieces,
      lines: state.lines,
      pieces: state.pieces,
    };
  }

  return {
    GAME_ID,
    ROWS,
    COLS,
    PIECES,
    PIECE_KEYS,
    END_REASONS,
    createGame,
    randomPiece,
    landingRow,
    isLegalDecision,
    legalActions,
    applyDecision,
    observe,
    result,
  };
});
