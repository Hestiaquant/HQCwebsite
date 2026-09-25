/*
 * 街機可注入種子亂數（arcade/engine/rng.js）
 *
 * 做什麼：提供 mulberry32 種子亂數產生器。遊戲引擎不自己呼叫 Math.random，
 *   一律由呼叫端注入亂數函式，同一個種子就會得到同一串亂數，因此同一個種子必得同一局面。
 * 輸入：mulberry32(seed) 的 seed 為 0 到 4294967295 的整數。
 * 輸出：一個無參數函式，每次呼叫回傳 [0, 1) 之間的浮點數。
 * 失敗時：seed 不是該範圍內的整數時 throw TypeError，不會悄悄改用時間或 Math.random。
 * 載入方式：瀏覽器用一般 script 標籤載入（掛在 globalThis.HestiaArcade.rng）；
 *   Node 用 require 載入（module.exports）。不碰 DOM、不連網。
 */
(function (root, factory) {
  "use strict";
  // [街機] 通用模組包裝：Node 走 module.exports，瀏覽器掛到 HestiaArcade 命名空間
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    const ns = (root.HestiaArcade = root.HestiaArcade || {});
    ns.rng = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // [街機] 種子範圍
  const SEED_MAX = 4294967295;

  /**
   * 檢查種子是否為合法整數。
   * 輸入：任意值。
   * 輸出：合法時回 true，否則回 false；不會 throw。
   */
  function isValidSeed(seed) {
    return Number.isInteger(seed) && seed >= 0 && seed <= SEED_MAX;
  }

  /**
   * 建立 mulberry32 種子亂數函式（公開領域的 32 位元演算法）。
   * 輸入：seed，0 到 4294967295 的整數。
   * 輸出：函式，每次呼叫回傳 [0, 1) 的浮點數；同種子產生完全相同的序列。
   * 失敗時：種子不合法 throw TypeError。
   */
  function mulberry32(seed) {
    if (!isValidSeed(seed)) {
      throw new TypeError("種子必須是 0 到 4294967295 的整數，收到：" + String(seed));
    }
    let a = seed >>> 0;
    // [街機] 亂數本體：每次呼叫推進內部狀態一次
    return function next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  return { SEED_MAX, isValidSeed, mulberry32 };
});
