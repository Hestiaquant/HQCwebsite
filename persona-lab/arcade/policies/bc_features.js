/*
 * 行為複製候選特徵（arcade/policies/bc_features.js）
 *
 * 做什麼：把一個觀測值展開成「合法候選動作清單」，並替每個候選算一列整數特徵。
 *   行為複製策略網路對每個候選打一個分數，選分數最高者；錄製訓練資料（tools/arcade/run_games.mjs --record）
 *   與瀏覽器、Node 推論都呼叫這同一份程式，特徵只有這一個實作，訓練端 Python 只讀錄好的特徵，不重算。
 *   特徵設計與理由寫在 arcade/FEATURES.md。
 * 候選順序（固定，標籤就是候選清單的索引）：
 *   貪吃蛇：UP、DOWN、LEFT、RIGHT 去掉正對目前方向的迴轉，永遠 3 個（與引擎 legalActions 相同）。
 *   俄羅斯方塊：先旋轉再欄位，列出讓方塊留在盤面內的所有落點（與引擎 legalActions 及規則專家的窮舉順序相同）。
 * 輸入：candidates(遊戲代號, 觀測值)；觀測值形狀與引擎 observe 相同。
 * 輸出：{ actions: 決策物件陣列, features: 每個候選一列整數特徵 }；兩者長度相同、順序對應。
 * 失敗時：遊戲代號不認得或觀測值缺欄位時 throw TypeError；不會回傳半套候選。
 * 載入方式：瀏覽器需先載入 engine/snake.js 與 engine/tetris.js（掛在 HestiaArcade.bcFeatures）；
 *   Node 以 require 載入並自行 require 引擎。不碰 DOM、不用 Math.random。
 */
(function (root, factory) {
  "use strict";
  // [街機] 通用模組包裝：Node 以 require 取得引擎，瀏覽器從 HestiaArcade 命名空間取
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("../engine/snake.js"), require("../engine/tetris.js"));
  } else {
    const ns = (root.HestiaArcade = root.HestiaArcade || {});
    ns.bcFeatures = factory(ns.snake, ns.tetris);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (snakeLib, tetrisLib) {
  "use strict";

  // [街機] 特徵版本：特徵定義只要改動就要改版本字串，權重檔記錄訓練時的版本，版本不符時拒絕載入
  const FEATURE_VERSION = "bc_features/1";

  // [街機] 特徵名稱（順序即特徵列的欄位順序；各欄意義見 arcade/FEATURES.md）
  const FEATURE_NAMES = {
    snake: [
      "wall", "body", "dist", "closer", "eat", "space50", "space_all", "free_nbrs",
      "straight", "dir_up", "dir_down", "dir_left", "dir_right", "length",
    ],
    tetris: [
      "lines", "holes", "bump", "drop_row", "agg_height", "max_height", "holes_after",
      "wells", "row_trans", "col_trans", "rot", "col",
    ],
  };

  // [街機] 規則專家自由空間搜尋的截止上限（與 rule_snake.js 相同，讓 space50 就是規則專家看到的數字）
  const RULE_SPACE_LIMIT = 50;

  /**
   * 把座標轉成集合用的整數鍵。
   * 輸入：x、y 整數、盤寬。
   * 輸出：整數鍵（盤面外的座標也有唯一鍵，但不會被查到）。
   */
  function key(x, y, size) {
    return y * size + x;
  }

  /**
   * 從起點做廣度優先搜尋，數可到達的空格數（起點自己算一格）。
   * 輸入：起點 x、y、盤寬、蛇身集合（整數鍵）、上限 limit（null 表示不設上限）。
   * 輸出：已造訪格數。limit 不為 null 時與規則專家完全相同：只在迴圈開頭檢查上限、
   *   鄰格依 UP、DOWN、LEFT、RIGHT 順序展開，所以結果可能超過上限最多 3 格。
   * 失敗時：不 throw。
   */
  function reachable(sx, sy, size, bodySet, limit) {
    const visited = new Set([key(sx, sy, size)]);
    const qx = [sx];
    const qy = [sy];
    let qi = 0;
    const order = snakeLib.DIRECTIONS;
    while (qi < qx.length && (limit === null || visited.size < limit)) {
      const cx = qx[qi];
      const cy = qy[qi];
      qi += 1;
      for (const d of order) {
        const nx = cx + snakeLib.DELTAS[d][0];
        const ny = cy + snakeLib.DELTAS[d][1];
        if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
        const k = key(nx, ny, size);
        if (bodySet.has(k) || visited.has(k)) continue;
        visited.add(k);
        qx.push(nx);
        qy.push(ny);
      }
    }
    return visited.size;
  }

  /**
   * 貪吃蛇：列出 3 個合法方向並替每個方向算 14 個整數特徵。
   * 輸入：觀測值 { head, food, body, grid_size, direction }。
   * 輸出：{ actions: [{ action }], features: [[14 個整數], ...] }。
   * 失敗時：缺 head、food、body 陣列或 direction 不是四個方向之一時 throw TypeError。
   */
  function snakeCandidates(obs) {
    if (!obs || !Array.isArray(obs.head) || !Array.isArray(obs.food) || !Array.isArray(obs.body)) {
      throw new TypeError("貪吃蛇特徵需要 head、food、body 三個陣列欄位");
    }
    const dir = obs.direction;
    if (snakeLib.DIRECTIONS.indexOf(dir) === -1) {
      throw new TypeError("貪吃蛇特徵需要合法的 direction，收到：" + String(dir));
    }
    const size = obs.grid_size === undefined ? snakeLib.GRID_SIZE : obs.grid_size;
    const hx = obs.head[0];
    const hy = obs.head[1];
    const fx = obs.food[0];
    const fy = obs.food[1];
    const bodySet = new Set(obs.body.map((b) => key(b[0], b[1], size)));
    const distNow = Math.abs(hx - fx) + Math.abs(hy - fy);
    const actions = [];
    const features = [];

    // [街機] 逐方向算特徵；迴轉方向不是合法動作，不列為候選
    for (const d of snakeLib.DIRECTIONS) {
      if (d === snakeLib.OPPOSITE[dir]) continue;
      const nx = hx + snakeLib.DELTAS[d][0];
      const ny = hy + snakeLib.DELTAS[d][1];
      const wall = nx < 0 || nx >= size || ny < 0 || ny >= size ? 1 : 0;
      const body = !wall && bodySet.has(key(nx, ny, size)) ? 1 : 0;
      const blocked = wall || body;
      const dist = Math.abs(nx - fx) + Math.abs(ny - fy);
      const eat = !blocked && nx === fx && ny === fy ? 1 : 0;
      let space50 = 0;
      let spaceAll = 0;
      let freeNbrs = 0;
      if (!blocked) {
        space50 = reachable(nx, ny, size, bodySet, RULE_SPACE_LIMIT);
        spaceAll = reachable(nx, ny, size, bodySet, null);
        for (const d2 of snakeLib.DIRECTIONS) {
          const ax = nx + snakeLib.DELTAS[d2][0];
          const ay = ny + snakeLib.DELTAS[d2][1];
          if (ax >= 0 && ax < size && ay >= 0 && ay < size && !bodySet.has(key(ax, ay, size))) freeNbrs += 1;
        }
      }
      actions.push({ action: d });
      features.push([
        wall,
        body,
        dist,
        dist < distNow ? 1 : 0,
        eat,
        space50,
        spaceAll,
        freeNbrs,
        d === dir ? 1 : 0,
        d === "UP" ? 1 : 0,
        d === "DOWN" ? 1 : 0,
        d === "LEFT" ? 1 : 0,
        d === "RIGHT" ? 1 : 0,
        obs.body.length,
      ]);
    }
    return { actions, features };
  }

  /**
   * 算盤面各欄高度（最上方方塊到底部的格數，空欄為 0）。
   * 輸入：盤面（ROWS 列乘 COLS 欄的 0 與 1）。
   * 輸出：長度 COLS 的整數陣列。
   */
  function columnHeights(grid) {
    const rows = grid.length;
    const cols = grid[0].length;
    const h = new Array(cols).fill(0);
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        if (grid[r][c] === 1) {
          h[c] = rows - r;
          break;
        }
      }
    }
    return h;
  }

  /**
   * 數空洞：每欄第一個方塊以下的空格數（與規則專家的定義相同）。
   * 輸入：盤面。
   * 輸出：空洞總數。
   */
  function countHoles(grid) {
    let holes = 0;
    const cols = grid[0].length;
    for (let c = 0; c < cols; c++) {
      let seen = false;
      for (let r = 0; r < grid.length; r++) {
        if (grid[r][c] === 1) seen = true;
        else if (seen) holes += 1;
      }
    }
    return holes;
  }

  /**
   * 起伏度：相鄰兩欄高度差的絕對值總和（與規則專家的定義相同）。
   * 輸入：各欄高度陣列。
   * 輸出：整數。
   */
  function bumpiness(heights) {
    let s = 0;
    for (let c = 0; c + 1 < heights.length; c++) s += Math.abs(heights[c] - heights[c + 1]);
    return s;
  }

  /**
   * 俄羅斯方塊：列出目前方塊所有合法落點，模擬硬落後替每個落點算 12 個整數特徵。
   * 前 4 欄（lines、holes、bump、drop_row）與規則專家的計算方式完全相同（在消行之前的盤面上算）；
   *   其餘為消行之後盤面的描述量與落點本身的欄位、旋轉。
   * 輸入：觀測值 { piece, grid, next_piece }（next_piece 不使用）。
   * 輸出：{ actions: [{ target_col, target_rot }], features: [[12 個整數], ...] }。
   * 失敗時：piece 不是七種方塊之一或 grid 不是 ROWS 列乘 COLS 欄時 throw TypeError。
   */
  function tetrisCandidates(obs) {
    const ROWS = tetrisLib.ROWS;
    const COLS = tetrisLib.COLS;
    if (!obs || typeof obs.piece !== "string" || !Object.prototype.hasOwnProperty.call(tetrisLib.PIECES, obs.piece)) {
      throw new TypeError("俄羅斯方塊特徵需要七種方塊之一的 piece，收到：" + String(obs && obs.piece));
    }
    if (!Array.isArray(obs.grid) || obs.grid.length !== ROWS || obs.grid.some((row) => !Array.isArray(row) || row.length !== COLS)) {
      throw new TypeError("俄羅斯方塊特徵需要 " + ROWS + " 列乘 " + COLS + " 欄的 grid");
    }
    const variants = tetrisLib.PIECES[obs.piece];
    const actions = [];
    const features = [];

    for (let rot = 0; rot < variants.length; rot++) {
      const shape = variants[rot];
      const maxDx = Math.max.apply(null, shape.map((p) => p[0]));
      for (let col = 0; col <= COLS - 1 - maxDx; col++) {
        // [街機] 模擬硬落，落點與引擎 landingRow 相同
        const dropRow = tetrisLib.landingRow(obs.grid, shape, col);
        const placed = obs.grid.map((row) => row.slice());
        for (const [dx, dy] of shape) {
          const r = dropRow + dy;
          const c = col + dx;
          if (r >= 0 && r < ROWS && c >= 0 && c < COLS) placed[r][c] = 1;
        }

        // [街機] 規則專家的四個量：在消行之前的盤面上算
        const fullRows = placed.filter((row) => row.every((v) => v === 1)).length;
        const holes = countHoles(placed);
        const bump = bumpiness(columnHeights(placed));

        // [街機] 消行之後的盤面描述量
        const cleared = placed.filter((row) => !row.every((v) => v === 1));
        while (cleared.length < ROWS) cleared.unshift(new Array(COLS).fill(0));
        const heights = columnHeights(cleared);
        const aggHeight = heights.reduce((a, b) => a + b, 0);
        const maxHeight = Math.max.apply(null, heights);
        const holesAfter = countHoles(cleared);

        // [街機] 井：欄頂以上、左右都被擋住（牆或方塊）的空格數
        let wells = 0;
        for (let c = 0; c < COLS; c++) {
          for (let r = 0; r < ROWS - heights[c]; r++) {
            const leftBlocked = c === 0 || cleared[r][c - 1] === 1;
            const rightBlocked = c === COLS - 1 || cleared[r][c + 1] === 1;
            if (leftBlocked && rightBlocked) wells += 1;
          }
        }

        // [街機] 列轉換：每列由左到右，左右牆視為有方塊，相鄰兩格一有一無就算一次
        let rowTrans = 0;
        for (let r = 0; r < ROWS; r++) {
          let prev = 1;
          for (let c = 0; c < COLS; c++) {
            if (cleared[r][c] !== prev) rowTrans += 1;
            prev = cleared[r][c];
          }
          if (prev !== 1) rowTrans += 1;
        }

        // [街機] 欄轉換：每欄由上到下，上方視為空、底部視為有方塊
        let colTrans = 0;
        for (let c = 0; c < COLS; c++) {
          let prev = 0;
          for (let r = 0; r < ROWS; r++) {
            if (cleared[r][c] !== prev) colTrans += 1;
            prev = cleared[r][c];
          }
          if (prev !== 1) colTrans += 1;
        }

        actions.push({ target_col: col, target_rot: rot });
        features.push([fullRows, holes, bump, dropRow, aggHeight, maxHeight, holesAfter, wells, rowTrans, colTrans, rot, col]);
      }
    }
    return { actions, features };
  }

  /**
   * 依遊戲代號列出候選與特徵。
   * 輸入：遊戲代號（"snake" 或 "tetris"）、觀測值。
   * 輸出：同 snakeCandidates 或 tetrisCandidates。
   * 失敗時：遊戲代號不認得時 throw TypeError。
   */
  function candidates(game, obs) {
    if (game === "snake") return snakeCandidates(obs);
    if (game === "tetris") return tetrisCandidates(obs);
    throw new TypeError("不認得的遊戲代號：" + String(game));
  }

  /**
   * 找出某個決策是候選清單中的第幾個（錄製訓練標籤用）。
   * 輸入：遊戲代號、候選動作陣列、決策物件。
   * 輸出：索引（0 起算）；決策不在候選清單中（非法動作）時回 -1。
   */
  function indexOfDecision(game, actions, decision) {
    if (!decision || typeof decision !== "object") return -1;
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      if (game === "snake" && a.action === decision.action) return i;
      if (game === "tetris" && a.target_col === decision.target_col && a.target_rot === decision.target_rot) return i;
    }
    return -1;
  }

  return { FEATURE_VERSION, FEATURE_NAMES, RULE_SPACE_LIMIT, candidates, snakeCandidates, tetrisCandidates, indexOfDecision };
});
