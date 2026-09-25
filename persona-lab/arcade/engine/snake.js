/*
 * 貪吃蛇遊戲引擎（arcade/engine/snake.js）
 *
 * 做什麼：從原版街機頁 arcade.html 抽出貪吃蛇的遊戲規則（原檔第 726 到 749 行的盤面與生成食物、
 *   第 888 到 914 行的移動與碰撞、第 936 到 947 行的開局狀態），改寫成不碰 DOM 的純邏輯模組，
 *   瀏覽器展示頁與 Node 無頭對局器共用同一份規則。
 * 與原版相同的規則：20 乘 20 盤面；開局蛇身 (10,10)、(10,11)、(10,12) 朝上；每步先移動蛇頭，
 *   撞牆或撞到目前任何一節蛇身（含尾巴那一節）就結束；吃到食物加 10 分且蛇身變長，
 *   否則尾巴縮回；食物以拒絕取樣放在蛇身以外的格子（先抽 x 再抽 y）。
 * 與原版不同的地方（都為了公平比較與可重現）：
 *   1. 亂數由呼叫端注入，不用 Math.random，同種子同局面。
 *   2. 決策若不是四個方向之一，或是正對目前方向的迴轉，判為非法動作並結束該局
 *      （原版迴轉會撞上第二節蛇身而死，結果相同，但這裡另外標明原因以便統計）。
 *   3. 蛇身佔滿全盤時結束並標為 board_full（原版在這種情況會無限迴圈找不到食物位置）。
 * 輸入：createGame({ rng }) 的 rng 為回傳 [0,1) 的函式；applyDecision 的決策物件 { action }。
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
    ns.snake = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // [街機] 常數（照抄原版 arcade.html 第 726、801 到 804、890 行）
  const GAME_ID = "snake";
  const GRID_SIZE = 20;
  const DIRECTIONS = ["UP", "DOWN", "LEFT", "RIGHT"];
  const DELTAS = { UP: [0, -1], DOWN: [0, 1], LEFT: [-1, 0], RIGHT: [1, 0] };
  const OPPOSITE = { UP: "DOWN", DOWN: "UP", LEFT: "RIGHT", RIGHT: "LEFT" };
  const FOOD_POINTS = 10;
  const INITIAL_BODY = [
    { x: 10, y: 10 },
    { x: 10, y: 11 },
    { x: 10, y: 12 },
  ];

  // [街機] 結束原因代碼
  const END_REASONS = {
    WALL: "wall",
    SELF: "self",
    ILLEGAL: "illegal_action",
    BOARD_FULL: "board_full",
  };

  /**
   * 在蛇身以外的格子放食物（原版 spawnFood，第 740 到 749 行）。
   * 輸入：遊戲狀態（會被就地修改 food）。
   * 輸出：放置成功回 true；蛇身已佔滿全盤、沒有空格時回 false，food 不變。
   * 失敗時：不 throw；亂數函式本身出錯時錯誤直接往上拋。
   */
  function spawnFood(state) {
    const size = state.gridSize;
    if (state.body.length >= size * size) {
      return false;
    }
    // [街機] 拒絕取樣：與原版相同，先抽 x 再抽 y，落在蛇身上就重抽
    for (;;) {
      const fx = Math.floor(state.rng() * size);
      const fy = Math.floor(state.rng() * size);
      if (!state.body.some((b) => b.x === fx && b.y === fy)) {
        state.food = { x: fx, y: fy };
        return true;
      }
    }
  }

  /**
   * 建立一局新遊戲（對應原版 resetSnakeGame，第 936 到 947 行）。
   * 輸入：options.rng，回傳 [0,1) 的亂數函式（通常由 rng.js 的 mulberry32(種子) 產生）。
   * 輸出：遊戲狀態物件 { gridSize, body, dir, food, score, steps, over, endReason, rng }。
   * 失敗時：rng 不是函式 throw TypeError。
   */
  function createGame(options) {
    const rng = options && options.rng;
    if (typeof rng !== "function") {
      throw new TypeError("createGame 需要注入亂數函式 options.rng");
    }
    const state = {
      game: GAME_ID,
      gridSize: GRID_SIZE,
      body: INITIAL_BODY.map((b) => ({ x: b.x, y: b.y })),
      dir: "UP",
      food: null,
      score: 0,
      steps: 0,
      over: false,
      endReason: null,
      rng: rng,
    };
    spawnFood(state);
    return state;
  }

  /**
   * 判斷一個動作在目前局面是否合法。
   * 輸入：遊戲狀態、動作字串。
   * 輸出：是四個方向之一且不是正對目前方向的迴轉時回 true，否則回 false；不會 throw。
   */
  function isLegalAction(state, action) {
    return DIRECTIONS.indexOf(action) !== -1 && action !== OPPOSITE[state.dir];
  }

  /**
   * 判斷策略輸出的決策物件是否合法（策略介面統一用 { action } 表示貪吃蛇決策）。
   * 輸入：遊戲狀態、決策物件。
   * 輸出：合法回 true，否則回 false；決策不是物件也只回 false，不會 throw。
   */
  function isLegalDecision(state, decision) {
    return !!decision && typeof decision === "object" && isLegalAction(state, decision.action);
  }

  /**
   * 列出目前局面的所有合法動作（依 UP、DOWN、LEFT、RIGHT 的固定順序）。
   * 輸入：遊戲狀態。
   * 輸出：動作字串陣列（貪吃蛇永遠有三個）。
   */
  function legalActions(state) {
    return DIRECTIONS.filter((d) => isLegalAction(state, d));
  }

  /**
   * 結束一局並記錄原因。
   * 輸入：遊戲狀態、結束原因代碼。
   * 輸出：本步的結果物件 { ate: false, over: true, endReason }。
   */
  function finish(state, reason) {
    state.over = true;
    state.endReason = reason;
    return { ate: false, over: true, endReason: reason };
  }

  /**
   * 依決策前進一步（原版 stepSnake 的移動與碰撞段，第 888 到 914 行）。
   * 輸入：遊戲狀態（就地修改）、決策物件 { action }。
   * 輸出：{ ate, over, endReason }；ate 表示本步吃到食物。
   * 失敗時：對已結束的局面呼叫 throw Error；非法決策不 throw，改為結束該局並標 illegal_action。
   */
  function applyDecision(state, decision) {
    if (state.over) {
      throw new Error("這一局已經結束，不能再下決策");
    }
    if (!isLegalDecision(state, decision)) {
      return finish(state, END_REASONS.ILLEGAL);
    }
    // [街機] 移動：先轉向再算新蛇頭
    state.dir = decision.action;
    const delta = DELTAS[state.dir];
    const head = state.body[0];
    const nextHead = { x: head.x + delta[0], y: head.y + delta[1] };
    const size = state.gridSize;

    // [街機] 碰撞：與原版相同，拿新蛇頭比對移動前的整條蛇身（含尾巴）
    if (nextHead.x < 0 || nextHead.x >= size || nextHead.y < 0 || nextHead.y >= size) {
      return finish(state, END_REASONS.WALL);
    }
    if (state.body.some((b) => b.x === nextHead.x && b.y === nextHead.y)) {
      return finish(state, END_REASONS.SELF);
    }

    state.body.unshift(nextHead);
    state.steps += 1;

    // [街機] 進食：吃到就加分並生成新食物，沒吃到就縮尾
    if (nextHead.x === state.food.x && nextHead.y === state.food.y) {
      state.score += FOOD_POINTS;
      if (!spawnFood(state)) {
        state.over = true;
        state.endReason = END_REASONS.BOARD_FULL;
        return { ate: true, over: true, endReason: END_REASONS.BOARD_FULL };
      }
      return { ate: true, over: false, endReason: null };
    }
    state.body.pop();
    return { ate: false, over: false, endReason: null };
  }

  /**
   * 產生給策略看的觀測值，形狀與原版後端 /decision/snake 的請求相同。
   * 輸入：遊戲狀態。
   * 輸出：{ head: [x,y], food: [x,y], body: [[x,y],...], grid_size, direction }，全部是複本，
   *   策略改動它不會影響遊戲狀態。
   */
  function observe(state) {
    return {
      head: [state.body[0].x, state.body[0].y],
      food: [state.food.x, state.food.y],
      body: state.body.map((b) => [b.x, b.y]),
      grid_size: state.gridSize,
      direction: state.dir,
    };
  }

  /**
   * 整理一局的成績，給對局器與展示頁的統計表用。
   * 輸入：遊戲狀態。
   * 輸出：{ score, steps, length, foods }；score 為原版計分（每個食物 10 分），steps 為成功移動的步數。
   */
  function result(state) {
    return {
      score: state.score,
      steps: state.steps,
      length: state.body.length,
      foods: state.score / FOOD_POINTS,
    };
  }

  return {
    GAME_ID,
    GRID_SIZE,
    DIRECTIONS,
    DELTAS,
    OPPOSITE,
    FOOD_POINTS,
    END_REASONS,
    createGame,
    spawnFood,
    isLegalAction,
    isLegalDecision,
    legalActions,
    applyDecision,
    observe,
    result,
  };
});
