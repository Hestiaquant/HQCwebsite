/*
 * 展示頁執行設定範本（showcase_frontend/config.template.js，建置後輸出為 showcase_dist/config.js）
 *
 * 做什麼：只放後端公開網址與公布時段兩個值（spec/05 第七章），不放通行碼或任何祕密。
 * 輸入：tools/build_showcase.py 以參數或環境變數代入兩個佔位字樣（連同引號整段換成 JSON 字串）。
 * 輸出：全域唯讀物件 HESTIA_SHOWCASE_CONFIG，供 app.js 讀取。
 * 失敗時：佔位字樣沒有被代入時，api.js 會判定網址不合法而不發請求，頁面顯示時段外畫面。
 */
// [前端] 建置時代入的兩個值
globalThis.HESTIA_SHOWCASE_CONFIG = Object.freeze({
  API_BASE: "https://demo-node.tail48edf8.ts.net",
  PUBLIC_HOURS: "09:00-23:00"
});
