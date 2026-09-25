/*
 * 行為複製策略網路的前向計算（arcade/policies/bc_forward.js）
 *
 * 做什麼：用原生 JavaScript（不靠任何函式庫）執行 tools/arcade/train_bc.py 匯出的小型多層感知器。
 *   網路對每個合法候選動作的特徵列打一個分數（logit），選分數最高的候選；平手時取候選清單中較前面者，
 *   與 PyTorch 的 argmax 規則相同。特徵由 bc_features.js 計算，這裡只做標準化、矩陣乘法與 ReLU。
 * 這是什麼：用規則專家的對局紀錄訓練出來的模仿策略，學的是規則專家的選擇，天花板就是規則專家。
 * 權重檔格式（arcade/policies/bc_snake.json、bc_tetris.json）：
 *   { format, game, feature_version, feature_names, input_mean, input_std,
 *     layers: [{ w: 輸出乘輸入的二維陣列, b: 輸出長度陣列, act: "relu" 或 "linear" }, ...], training: {...} }
 *   最後一層輸出必須是 1（每個候選一個分數）。
 * 輸入：createPolicy(權重物件, 特徵模組)；decide(觀測值)；scoreObservation(權重, 特徵模組, 遊戲, 觀測值)。
 * 輸出：策略物件 { id, game, label, model, decide, score }；decide 回傳與規則專家同形狀的決策物件（含 reason）。
 * 失敗時：權重格式不符、特徵版本或名稱與 bc_features.js 不一致時 createPolicy throw TypeError，
 *   不會用對不上的權重悄悄算出錯的動作；觀測值有誤時由特徵模組 throw TypeError。
 * 載入方式：瀏覽器依序載入 bc_features.js、bc_weights.js、本檔，本檔會把兩個策略登記到
 *   HestiaArcade.policies.bc_snake 與 bc_tetris（權重或特徵模組缺漏時不登記，展示頁會停用該選項）；
 *   Node 以 require 載入，權重由呼叫端讀檔後傳入。不碰 DOM、不用 Math.random。
 */
(function (root, factory) {
  "use strict";
  // [街機] 通用模組包裝：Node 走 module.exports；瀏覽器掛到 HestiaArcade.bcForward 並登記策略
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    const ns = (root.HestiaArcade = root.HestiaArcade || {});
    ns.bcForward = api;
    ns.policies = ns.policies || {};
    if (ns.bcWeights && ns.bcFeatures) {
      for (const game of ["snake", "tetris"]) {
        if (ns.bcWeights[game]) {
          const policy = api.createPolicy(ns.bcWeights[game], ns.bcFeatures);
          ns.policies[policy.id] = policy;
        }
      }
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // [街機] 格式與顯示名稱
  const FORMAT = "hestia-arcade-bc/1";
  const LABEL = "行為複製策略網路";

  /**
   * 檢查權重物件的形狀，並確認與特徵模組的版本、欄位名稱一致。
   * 輸入：權重物件、特徵模組（bc_features.js）。
   * 輸出：通過時回 true。
   * 失敗時：任何一項不符時 throw TypeError，訊息寫明哪一項不符。
   */
  function validateModel(model, features) {
    if (!model || typeof model !== "object") throw new TypeError("權重必須是物件");
    if (model.format !== FORMAT) throw new TypeError("權重格式不符：" + String(model.format));
    if (model.game !== "snake" && model.game !== "tetris") throw new TypeError("權重的遊戲代號不認得：" + String(model.game));
    if (features) {
      if (model.feature_version !== features.FEATURE_VERSION) {
        throw new TypeError("特徵版本不符：權重為 " + model.feature_version + "，程式為 " + features.FEATURE_VERSION);
      }
      if (JSON.stringify(model.feature_names) !== JSON.stringify(features.FEATURE_NAMES[model.game])) {
        throw new TypeError("特徵名稱與順序不符");
      }
    }
    const nIn = model.feature_names.length;
    if (!Array.isArray(model.input_mean) || model.input_mean.length !== nIn) throw new TypeError("input_mean 長度不符");
    if (!Array.isArray(model.input_std) || model.input_std.length !== nIn) throw new TypeError("input_std 長度不符");
    if (model.input_std.some((s) => !(s > 0))) throw new TypeError("input_std 必須全為正數");
    if (!Array.isArray(model.layers) || model.layers.length < 1) throw new TypeError("layers 不可為空");
    let width = nIn;
    model.layers.forEach((layer, li) => {
      if (!Array.isArray(layer.w) || !Array.isArray(layer.b) || layer.w.length !== layer.b.length) {
        throw new TypeError("第 " + li + " 層 w 與 b 的輸出長度不符");
      }
      if (layer.w.some((row) => !Array.isArray(row) || row.length !== width)) {
        throw new TypeError("第 " + li + " 層 w 的輸入長度應為 " + width);
      }
      if (layer.act !== "relu" && layer.act !== "linear") throw new TypeError("第 " + li + " 層 act 不認得：" + layer.act);
      const values = layer.b.concat(...layer.w);
      if (values.some((v) => typeof v !== "number" || !Number.isFinite(v))) throw new TypeError("第 " + li + " 層含非有限數字");
      width = layer.b.length;
    });
    if (width !== 1) throw new TypeError("最後一層輸出必須是 1，收到 " + width);
    if (model.layers[model.layers.length - 1].act !== "linear") throw new TypeError("最後一層必須是 linear");
    return true;
  }

  /**
   * 對一列特徵做前向計算，得到一個分數。
   * 輸入：權重物件、特徵列（數字陣列，長度等於 feature_names）。
   * 輸出：分數（float64）。
   * 失敗時：不 throw；特徵長度不符時結果無意義，由 validateModel 與特徵模組事先保證長度。
   */
  function forwardOne(model, x) {
    const mean = model.input_mean;
    const std = model.input_std;
    let h = new Array(x.length);
    for (let i = 0; i < x.length; i++) h[i] = (x[i] - mean[i]) / std[i];
    for (const layer of model.layers) {
      const out = new Array(layer.b.length);
      for (let o = 0; o < out.length; o++) {
        const row = layer.w[o];
        let s = layer.b[o];
        for (let i = 0; i < h.length; i++) s += row[i] * h[i];
        out[o] = layer.act === "relu" ? (s > 0 ? s : 0) : s;
      }
      h = out;
    }
    return h[0];
  }

  /**
   * 對所有候選的特徵列打分數。
   * 輸入：權重物件、特徵矩陣（每個候選一列）。
   * 輸出：分數陣列，順序與候選相同。
   */
  function scoreAll(model, featureRows) {
    return featureRows.map((x) => forwardOne(model, x));
  }

  /**
   * 取分數最高的索引；平手取較前面者（與 PyTorch argmax 取第一個最大值相同）。
   * 輸入：分數陣列（至少一個）。
   * 輸出：索引。
   */
  function argmax(scores) {
    let best = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
    return best;
  }

  /**
   * 對一個觀測值完整算一次：候選、特徵、分數與選中的索引（一致性比對與測試用）。
   * 輸入：權重物件、特徵模組、遊戲代號、觀測值。
   * 輸出：{ actions, features, logits, index }。
   * 失敗時：觀測值有誤時由特徵模組 throw TypeError。
   */
  function scoreObservation(model, features, game, obs) {
    const cand = features.candidates(game, obs);
    const logits = scoreAll(model, cand.features);
    return { actions: cand.actions, features: cand.features, logits: logits, index: argmax(logits) };
  }

  /**
   * 用權重建立可對局的策略物件。
   * 輸入：權重物件、特徵模組（bc_features.js）。
   * 輸出：{ id: "bc_遊戲", game, label, model, decide(obs), score(obs) }。
   * 失敗時：權重與特徵不一致時 throw TypeError（見 validateModel）。
   */
  function createPolicy(model, features) {
    validateModel(model, features);
    const game = model.game;

    /**
     * 策略決策：選分數最高的候選。
     * 輸入：觀測值。
     * 輸出：貪吃蛇 { action, reason }；俄羅斯方塊 { action: "DROP", target_col, target_rot, reason }。
     */
    function decide(obs) {
      const r = scoreObservation(model, features, game, obs);
      const pick = r.actions[r.index];
      const top = r.logits[r.index].toFixed(2);
      if (game === "snake") {
        return { action: pick.action, reason: "策略網路評分最高（" + top + "，共 " + r.actions.length + " 個候選方向）" };
      }
      return {
        action: "DROP",
        target_col: pick.target_col,
        target_rot: pick.target_rot,
        reason: "策略網路評分最高：第 " + pick.target_col + " 欄 (旋轉 " + pick.target_rot + ")，評分 " + top +
          "，共 " + r.actions.length + " 個候選落點",
      };
    }

    return {
      id: "bc_" + game,
      game: game,
      label: LABEL,
      model: model,
      decide: decide,
      score: (obs) => scoreObservation(model, features, game, obs),
    };
  }

  return { FORMAT, LABEL, validateModel, forwardOne, scoreAll, argmax, scoreObservation, createPolicy };
});
