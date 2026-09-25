/*
 * 無頭對局與統計（arcade/engine/match.js）
 *
 * 做什麼：用同一套迴圈讓任一策略下完一局（不畫圖），並把多局成績整理成平均、標準差與 95% 信賴區間。
 *   Node 對局器 tools/arcade/run_games.mjs、測試 tools/arcade/test_engine.mjs 與瀏覽器展示頁的批次統計共用。
 * 輸入：playGame(引擎, 策略, { seed, maxSteps, timing, onStep })；引擎為 snake.js 或 tetris.js，
 *   策略為有 decide(觀測值) 方法的物件。
 * 輸出：每局 { seed, score, steps, end_reason, decisions, illegal, ...各遊戲額外欄位 }；
 *   summarize 回 { n, mean, sd, min, max, median, ci95_low, ci95_high }。
 * 失敗時：種子不合法 throw TypeError（由 rng.js 丟出）；策略 decide 丟出的錯誤不攔截，直接往上拋，
 *   讓呼叫端知道是策略壞了而不是遊戲結束。
 * 策略若有 reset(種子) 方法（例如隨機合法動作下限），每局開始前以本局種子呼叫一次，讓策略自己的亂數也可重現。
 */
(function (root, factory) {
  "use strict";
  // [街機] 通用模組包裝：Node 以 require 取得依賴，瀏覽器從 HestiaArcade 命名空間取（需先載入 rng.js）
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./rng.js"));
  } else {
    const ns = (root.HestiaArcade = root.HestiaArcade || {});
    ns.match = factory(ns.rng);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (rngLib) {
  "use strict";

  // [街機] 截斷上限預設值（原版沒有上限；無頭對局需要一個上限避免策略原地繞圈時跑不完）
  const DEFAULT_MAX_STEPS = { snake: 20000, tetris: 20000 };
  const TRUNCATED = "max_steps";

  // [街機] 雙尾 95% 的 t 分配臨界值，自由度 1 到 30；超過 30 用 1.96
  const T95 = [
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
    2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
  ];

  /**
   * 取得目前時間（毫秒，含小數），瀏覽器與 Node 都有 performance.now。
   * 輸入：無。
   * 輸出：毫秒數；環境沒有 performance 時退回 Date.now（精度較差）。
   */
  function nowMs() {
    const p = typeof performance !== "undefined" ? performance : null;
    return p && typeof p.now === "function" ? p.now() : Date.now();
  }

  /**
   * 用指定策略無頭下完一局。
   * 輸入：engine（snake.js 或 tetris.js 模組）、policy（有 decide 方法；有 reset 方法時開局先以種子呼叫）、options：
   *   seed（必填，整數）、maxSteps（決策次數上限，預設依遊戲）、timing（true 時量每次決策耗時）、
   *   onStep（選填，每次決策後呼叫 onStep(觀測值, 決策, 是否合法, 本步結果)，測試用）。
   * 輸出：{ seed, score, steps, end_reason, decisions, illegal, ...engine.result 的其他欄位 }；
   *   timing 為 true 時另有 decision_ms_mean 與 decision_ms_max。
   * 失敗時：見檔頭；非法決策不 throw，由引擎結束該局並標 illegal_action，illegal 計數加一。
   */
  function playGame(engine, policy, options) {
    const opts = options || {};
    const seed = opts.seed;
    const rng = rngLib.mulberry32(seed);
    if (typeof policy.reset === "function") policy.reset(seed);
    const maxSteps = opts.maxSteps === undefined ? DEFAULT_MAX_STEPS[engine.GAME_ID] : opts.maxSteps;
    const state = engine.createGame({ rng: rng });
    let decisions = 0;
    let illegal = 0;
    let timeSum = 0;
    let timeMax = 0;
    let truncated = false;

    // [街機] 對局迴圈：觀測、決策、檢查合法、推進
    while (!state.over) {
      if (decisions >= maxSteps) {
        truncated = true;
        break;
      }
      const obs = engine.observe(state);
      let decision;
      if (opts.timing) {
        const t0 = nowMs();
        decision = policy.decide(obs);
        const dt = nowMs() - t0;
        timeSum += dt;
        if (dt > timeMax) timeMax = dt;
      } else {
        decision = policy.decide(obs);
      }
      decisions += 1;
      const legal = engine.isLegalDecision(state, decision);
      if (!legal) illegal += 1;
      const outcome = engine.applyDecision(state, decision);
      if (typeof opts.onStep === "function") opts.onStep(obs, decision, legal, outcome);
    }

    const out = Object.assign({ seed: seed }, engine.result(state));
    out.end_reason = truncated ? TRUNCATED : state.endReason;
    out.decisions = decisions;
    out.illegal = illegal;
    if (opts.timing) {
      out.decision_ms_mean = decisions > 0 ? timeSum / decisions : 0;
      out.decision_ms_max = timeMax;
    }
    return out;
  }

  /**
   * 對一串數字算描述統計與平均數的 95% 信賴區間（t 分配）。
   * 輸入：數字陣列。
   * 輸出：{ n, mean, sd, min, max, median, ci95_low, ci95_high }；sd 為樣本標準差（除以 n 減 1）。
   *   n 為 1 時 sd 與信賴區間半寬記為 0；n 為 0 時各欄為 null。
   * 失敗時：陣列內有非有限數字時 throw TypeError。
   */
  function describe(values) {
    const n = values.length;
    if (n === 0) {
      return { n: 0, mean: null, sd: null, min: null, max: null, median: null, ci95_low: null, ci95_high: null };
    }
    for (const v of values) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new TypeError("統計只接受有限數字，收到：" + String(v));
      }
    }
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1) : 0;
    const sd = Math.sqrt(variance);
    const sorted = values.slice().sort((a, b) => a - b);
    const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    const t = n - 1 >= 1 && n - 1 <= 30 ? T95[n - 2] : 1.96;
    const half = n > 1 ? (t * sd) / Math.sqrt(n) : 0;
    return {
      n: n,
      mean: mean,
      sd: sd,
      min: sorted[0],
      max: sorted[n - 1],
      median: median,
      ci95_low: mean - half,
      ci95_high: mean + half,
    };
  }

  /**
   * 整理多局結果：分數與步數的描述統計、各結束原因的局數、非法決策總數。
   * 輸入：playGame 回傳的結果陣列。
   * 輸出：{ games, score, steps, end_reasons, illegal_total }。
   * 失敗時：同 describe。
   */
  function summarize(results) {
    const endReasons = {};
    let illegalTotal = 0;
    for (const r of results) {
      endReasons[r.end_reason] = (endReasons[r.end_reason] || 0) + 1;
      illegalTotal += r.illegal;
    }
    return {
      games: results.length,
      score: describe(results.map((r) => r.score)),
      steps: describe(results.map((r) => r.steps)),
      end_reasons: endReasons,
      illegal_total: illegalTotal,
    };
  }

  return { DEFAULT_MAX_STEPS, TRUNCATED, playGame, describe, summarize };
});
