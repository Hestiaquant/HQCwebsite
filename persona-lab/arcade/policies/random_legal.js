/*
 * 隨機合法動作下限（arcade/policies/random_legal.js）
 *
 * 做什麼：每一步從引擎認可的合法動作中均勻隨機挑一個，當作對照表的下限。它不看食物、不看盤面，
 *   只保證不送出非法動作（貪吃蛇仍可能直接撞牆或撞身，因為那是合法但致命的動作）。
 * 可重現：亂數由 rng.js 的 mulberry32 產生，對局器在每局開始時呼叫 reset(種子)，
 *   同一個種子必得同一串選擇；遊戲本身的亂數與策略的亂數分開，種子以固定常數混合後再用。
 * 輸入：create(遊戲代號) 建立策略；decide(觀測值)，觀測值形狀與引擎 observe 相同。
 * 輸出：策略物件 { id, game, label, reset, decide }；decide 回傳與規則專家同形狀的決策物件（含 reason）。
 * 失敗時：遊戲代號不認得時 throw TypeError；reset 收到不合法種子時由 rng.js throw TypeError；
 *   未呼叫 reset 就 decide 時使用種子 0，仍可重現。
 * 載入方式：瀏覽器需先載入 engine/rng.js、engine/snake.js、engine/tetris.js（掛在 HestiaArcade.randomLegal）；
 *   Node 以 require 載入。不碰 DOM、不用 Math.random。
 */
(function (root, factory) {
  "use strict";
  // [街機] 通用模組包裝：Node 以 require 取得依賴，瀏覽器從 HestiaArcade 命名空間取
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("../engine/rng.js"), require("../engine/snake.js"), require("../engine/tetris.js"));
  } else {
    const ns = (root.HestiaArcade = root.HestiaArcade || {});
    ns.randomLegal = factory(ns.rng, ns.snake, ns.tetris);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (rngLib, snakeLib, tetrisLib) {
  "use strict";

  // [街機] 策略身分與種子混合常數（讓策略亂數與遊戲亂數即使種子相同也不同步）
  const LABEL = "隨機合法動作下限";
  const SEED_SALT = 0x5bd1e995;

  /**
   * 列出觀測值下的合法動作（只看觀測值，不需要引擎狀態）。
   * 輸入：遊戲代號、觀測值。
   * 輸出：決策物件陣列；貪吃蛇 3 個方向，俄羅斯方塊為所有讓方塊留在盤面內的落點。
   * 失敗時：觀測值缺欄位時 throw TypeError。
   */
  function legalFromObs(game, obs) {
    if (game === "snake") {
      if (!obs || snakeLib.DIRECTIONS.indexOf(obs.direction) === -1) {
        throw new TypeError("隨機策略需要合法的 direction");
      }
      return snakeLib.DIRECTIONS.filter((d) => d !== snakeLib.OPPOSITE[obs.direction]).map((d) => ({ action: d }));
    }
    if (!obs || !Object.prototype.hasOwnProperty.call(tetrisLib.PIECES, obs.piece)) {
      throw new TypeError("隨機策略需要七種方塊之一的 piece");
    }
    const out = [];
    const variants = tetrisLib.PIECES[obs.piece];
    for (let rot = 0; rot < variants.length; rot++) {
      const maxDx = Math.max.apply(null, variants[rot].map((p) => p[0]));
      for (let col = 0; col <= tetrisLib.COLS - 1 - maxDx; col++) out.push({ target_col: col, target_rot: rot });
    }
    return out;
  }

  /**
   * 建立一個隨機合法動作策略。
   * 輸入：遊戲代號（"snake" 或 "tetris"）。
   * 輸出：策略物件 { id, game, label, reset(seed), decide(obs) }。
   * 失敗時：遊戲代號不認得時 throw TypeError。
   */
  function create(game) {
    if (game !== "snake" && game !== "tetris") {
      throw new TypeError("不認得的遊戲代號：" + String(game));
    }
    let next = rngLib.mulberry32(SEED_SALT >>> 0);

    /**
     * 以對局種子重設策略亂數（對局器每局開始時呼叫）。
     * 輸入：對局種子（0 到 4294967295 的整數）。
     * 輸出：無。
     * 失敗時：種子不合法時 throw TypeError。
     */
    function reset(seed) {
      if (!rngLib.isValidSeed(seed)) throw new TypeError("種子必須是 0 到 4294967295 的整數");
      next = rngLib.mulberry32((seed ^ SEED_SALT) >>> 0);
    }

    /**
     * 從合法動作中均勻挑一個。
     * 輸入：觀測值。
     * 輸出：決策物件（貪吃蛇 { action, reason }；俄羅斯方塊 { action: "DROP", target_col, target_rot, reason }）。
     */
    function decide(obs) {
      const legal = legalFromObs(game, obs);
      const pick = legal[Math.floor(next() * legal.length)];
      if (game === "snake") {
        return { action: pick.action, reason: "隨機挑選（" + legal.length + " 個合法方向之一）" };
      }
      return {
        action: "DROP",
        target_col: pick.target_col,
        target_rot: pick.target_rot,
        reason: "隨機挑選（" + legal.length + " 個合法落點之一）",
      };
    }

    return { id: "random_" + game, game: game, label: LABEL, reset: reset, decide: decide };
  }

  return { LABEL, SEED_SALT, create, legalFromObs };
});
