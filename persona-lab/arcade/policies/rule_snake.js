/*
 * 貪吃蛇 規則專家基準線（arcade/policies/rule_snake.js）
 *
 * 出處：custom_model_jev/hf_space_app/app.py 第 457 到 521 行 snake_decision，逐行移植成 JavaScript，
 *   評分公式、候選方向順序、平手時保留先出現者（嚴格大於才換）、自由空間搜尋的截止條件都與原檔相同；
 *   另以 tools/arcade/fixtures/rule_golden_v1.json 與原檔 Python 輸出逐筆比對。
 * 這是什麼：手寫的評分規則，不是訓練出來的模型。對每個不迴轉、不撞牆、不撞身的方向算
 *   距離分（(盤寬 乘 2 減 曼哈頓距離) 乘 15）加自由空間分（廣度優先搜尋可達格數 乘 25，最多約 50 格）
 *   加進食分（剛好吃到加 300），取最高分的方向。
 * 與原檔不同的地方：原檔回應帶一個寫死的信心值常數與自己量的延遲，本移植兩者都不輸出；
 *   延遲由呼叫端在決策前後計時，讓規則專家與學習策略用同一把尺量。
 * 輸入：觀測值 { head: [x,y], food: [x,y], body: [[x,y],...], grid_size, direction }（與原檔請求相同）。
 * 輸出：{ action: "UP"|"DOWN"|"LEFT"|"RIGHT", reason: 中文說明 }。
 * 失敗時：觀測值缺 head、food 或 body 時 throw TypeError；四個方向都走不通時回傳目前方向
 *   （與原檔相同，下一步會撞死，由引擎判定結束）。
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
  const ID = "rule_snake";
  const GAME = "snake";
  const LABEL = "規則專家基準線";

  // [街機] 方向表（原檔第 469 到 475 行；陣列保留 UP、DOWN、LEFT、RIGHT 的疊代順序）
  const OPPOSITE = { UP: "DOWN", DOWN: "UP", LEFT: "RIGHT", RIGHT: "LEFT" };
  const MOVES = [
    ["UP", [0, -1]],
    ["DOWN", [0, 1]],
    ["LEFT", [-1, 0]],
    ["RIGHT", [1, 0]],
  ];

  /**
   * 把座標轉成集合用的字串鍵（取代原檔的 tuple）。
   * 輸入：x、y 整數。
   * 輸出："x,y" 字串。
   */
  function cellKey(x, y) {
    return x + "," + y;
  }

  /**
   * 規則專家決策（原檔 snake_decision 本體）。
   * 輸入：觀測值，見檔頭說明；grid_size 缺省為 20、direction 缺省為 "UP"（與原檔請求模型預設相同）。
   * 輸出：{ action, reason }。
   * 失敗時：head、food、body 不是陣列時 throw TypeError。
   */
  function decide(req) {
    if (!req || !Array.isArray(req.head) || !Array.isArray(req.food) || !Array.isArray(req.body)) {
      throw new TypeError("rule_snake 需要 head、food、body 三個陣列欄位");
    }
    const hx = req.head[0];
    const hy = req.head[1];
    const fx = req.food[0];
    const fy = req.food[1];
    const gridSize = req.grid_size === undefined ? 20 : req.grid_size;
    const direction = req.direction === undefined ? "UP" : req.direction;
    const bodySet = new Set(req.body.map((b) => cellKey(b[0], b[1])));

    let bestDir = direction;
    let bestScore = -999999;
    let bestReason = "保持直行";

    /**
     * 自由空間：從起點做廣度優先搜尋，數可達的空格數（原檔第 481 到 492 行）。
     * 輸入：起點 [x, y]、截止上限 maxDepth（預設 50）。
     * 輸出：已造訪格數；與原檔相同只在迴圈開頭檢查上限，所以最多可能超過上限 3 格。
     * 失敗時：不 throw。
     */
    function calculateFreeSpace(start, maxDepth) {
      const limit = maxDepth === undefined ? 50 : maxDepth;
      const visited = new Set([cellKey(start[0], start[1])]);
      const queue = [start];
      let qi = 0; // 以讀取指標取代 pop(0)，先進先出順序相同
      while (qi < queue.length && visited.size < limit) {
        const curr = queue[qi];
        qi += 1;
        for (const [, [dx, dy]] of MOVES) {
          const nx = curr[0] + dx;
          const ny = curr[1] + dy;
          if (nx >= 0 && nx < gridSize && ny >= 0 && ny < gridSize) {
            const k = cellKey(nx, ny);
            if (!bodySet.has(k) && !visited.has(k)) {
              visited.add(k);
              queue.push([nx, ny]);
            }
          }
        }
      }
      return visited.size;
    }

    // [街機] 逐方向評分（原檔第 494 到 513 行）
    for (const [d, [dx, dy]] of MOVES) {
      if (d === OPPOSITE[direction]) continue;
      const nx = hx + dx;
      const ny = hy + dy;
      if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) continue;
      if (bodySet.has(cellKey(nx, ny))) continue;

      const distToFood = Math.abs(nx - fx) + Math.abs(ny - fy);
      const distScore = (gridSize * 2 - distToFood) * 15;
      const freeSpace = calculateFreeSpace([nx, ny]);
      const spaceScore = freeSpace * 25;
      const eatBonus = nx === fx && ny === fy ? 300 : 0;

      const score = distScore + spaceScore + eatBonus;
      if (score > bestScore) {
        bestScore = score;
        bestDir = d;
        bestReason = "導航獵食 (剩餘距離 " + distToFood + "，安全自由度 " + freeSpace + ")";
      }
    }

    return { action: bestDir, reason: bestReason };
  }

  return { id: ID, game: GAME, label: LABEL, decide };
});
