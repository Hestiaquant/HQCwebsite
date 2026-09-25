/*
 * 展示頁後端呼叫層（showcase_frontend/api.js）
 *
 * 做什麼：全站只有本檔呼叫後端。依 spec/05 契約第一章與第七章，只打 API_BASE 加 /api/chat 這一條路徑：
 *   GET 查狀態（5 秒逾時）、POST 送一個回合、DELETE 刪除我的對話。
 *   其他檔案（app.js、街機頁）一律不直接發網路請求。
 * 輸入：createClient({ apiBase, fetchImpl, timers, AbortControllerImpl })；各方法的參數見函式註解。
 *   通行碼只放在 X-Access-Code 標頭，不放本體、不放網址。
 * 輸出：Promise，解析成 { ok: true, status, data } 或 { ok: false, kind, status, error, data, retryAfter }。
 *   kind 是前端分流用的代碼（見 classifyError），前端只依 error 代碼分流，不解析 message。
 * 失敗時：網路錯誤、逾時、回應不是 JSON 都不會拋例外，一律回 ok 為 false 的物件；
 *   apiBase 不合法時每個方法都直接回 kind 為 network 的失敗，不發任何請求。
 * 載入方式：瀏覽器用一般 script 標籤載入（掛在 globalThis.HestiaShowcase.api）；Node 測試用 require。
 */
(function (root, factory) {
  "use strict";
  // [前端] 通用模組包裝：Node 走 module.exports，瀏覽器掛到 HestiaShowcase 命名空間
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    const ns = (root.HestiaShowcase = root.HestiaShowcase || {});
    ns.api = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // [前端] 契約常數（spec/05 第一章）
  const CHAT_PATH = "/api/chat";
  const ACCESS_HEADER = "X-Access-Code";
  const STATUS_TIMEOUT_MS = 5000; // 設計書 7.2 與 S7：5 秒內沒回應就切時段外畫面
  const TURN_TIMEOUT_MS = 200000; // 佇列等待 60 秒加單一階段上限 90 秒，再留餘裕
  const DELETE_TIMEOUT_MS = 30000;
  const DEFAULT_RETRY_SECONDS = { queue_full: 10, queue_timeout: 15 };
  const FALLBACK_RETRY_SECONDS = 30;

  /**
   * 整理後端網址：只接受 http 或 https 的來源（不帶路徑、查詢字串與帳密），去掉結尾斜線。
   * 輸入：任意值。
   * 輸出：合法時回 http 或 https 開頭、只有主機與埠的來源字串，否則回空字串；不會拋例外。
   */
  function normalizeBase(base) {
    if (typeof base !== "string") return "";
    const trimmed = base.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[A-Za-z0-9.\-]+(:\d{1,5})?$/.test(trimmed) && !/^https?:\/\/\[[0-9A-Fa-f:]+\](:\d{1,5})?$/.test(trimmed)) {
      return "";
    }
    return trimmed;
  }

  /**
   * 把 Retry-After 秒數整理成 1 到 3600 的整數。
   * 輸入：錯誤碼、回應本體（可能為 null）。
   * 輸出：整數秒；本體沒給時依錯誤碼用契約預設值（queue_full 10、queue_timeout 15），其餘 30。
   */
  function retrySeconds(code, body) {
    let value = body && typeof body.retry_after_seconds === "number" ? body.retry_after_seconds : NaN;
    if (!Number.isFinite(value) || value <= 0) {
      value = Object.prototype.hasOwnProperty.call(DEFAULT_RETRY_SECONDS, code)
        ? DEFAULT_RETRY_SECONDS[code]
        : FALLBACK_RETRY_SECONDS;
    }
    return Math.min(3600, Math.max(1, Math.ceil(value)));
  }

  /**
   * 依 HTTP 狀態碼與錯誤本體決定前端怎麼處理（spec/05 1.4 與第七章）。
   * 輸入：status 整數、body（已解析的 JSON 或 null）。
   * 輸出：{ kind, error, retryAfter }。kind 的值：
   *   unauthorized（401）、consent_required（428）、wait（429 全部與 503 queue_*，附 retryAfter）、
   *   paused（503 service_paused 或 outside_hours，要切時段外畫面）、too_large（413）、invalid（422）、
   *   not_ready（503 core_not_ready）、server_error（500 與其他 5xx）、unknown（其餘）。
   * 失敗時：不會拋例外；body 缺 error 欄位時 error 為空字串，依狀態碼歸類。
   */
  function classifyError(status, body) {
    const code = body && typeof body.error === "string" ? body.error : "";
    if (status === 401) return { kind: "unauthorized", error: code, retryAfter: 0 };
    if (status === 428) return { kind: "consent_required", error: code, retryAfter: 0 };
    if (status === 429) return { kind: "wait", error: code, retryAfter: retrySeconds(code, body) };
    if (status === 413) return { kind: "too_large", error: code, retryAfter: 0 };
    if (status === 422) return { kind: "invalid", error: code, retryAfter: 0 };
    if (status === 503) {
      if (code === "queue_full" || code === "queue_timeout") {
        return { kind: "wait", error: code, retryAfter: retrySeconds(code, body) };
      }
      if (code === "service_paused" || code === "outside_hours") {
        return { kind: "paused", error: code, retryAfter: 0 };
      }
      if (code === "core_not_ready") return { kind: "not_ready", error: code, retryAfter: 0 };
      return { kind: "server_error", error: code, retryAfter: 0 };
    }
    if (status >= 500) return { kind: "server_error", error: code, retryAfter: 0 };
    return { kind: "unknown", error: code, retryAfter: 0 };
  }

  /**
   * 建立後端呼叫物件。
   * 輸入：options.apiBase（後端網址）、options.fetchImpl（預設 globalThis.fetch）、
   *   options.setTimeout 與 options.clearTimeout（預設全域計時器）、options.AbortControllerImpl。
   * 輸出：{ apiBase, getStatus, sendTurn, deleteSession }。
   * 失敗時：沒有 fetch 可用或網址不合法時，各方法回 kind 為 network 的失敗，不拋例外。
   */
  function createClient(options) {
    const opts = options || {};
    const base = normalizeBase(opts.apiBase);
    const g = typeof globalThis !== "undefined" ? globalThis : {};
    const fetchImpl = opts.fetchImpl || (typeof g.fetch === "function" ? g.fetch.bind(g) : null);
    const setTimer = opts.setTimeout || g.setTimeout;
    const clearTimer = opts.clearTimeout || g.clearTimeout;
    const AbortImpl = opts.AbortControllerImpl || g.AbortController;

    /**
     * 發一個請求並在逾時後放棄。
     * 輸入：method、本體物件（可為 null）、額外標頭、逾時毫秒。
     * 輸出：{ status, body, failure }；failure 為 timeout、network 或空字串。
     * 失敗時：不拋例外，把原因放進 failure。
     */
    function request(method, payload, headers, timeoutMs) {
      if (!base || !fetchImpl) {
        return Promise.resolve({ status: 0, body: null, failure: "network" });
      }
      const controller = AbortImpl ? new AbortImpl() : null;
      let timedOut = false;
      return new Promise(function (resolve) {
        let settled = false;
        const timer = setTimer(function () {
          timedOut = true;
          if (controller) controller.abort();
          if (!settled) {
            settled = true;
            resolve({ status: 0, body: null, failure: "timeout" });
          }
        }, timeoutMs);
        const init = {
          method: method,
          headers: headers,
          mode: "cors",
          credentials: "omit",
          cache: "no-store",
          referrerPolicy: "no-referrer"
        };
        if (payload !== null) init.body = JSON.stringify(payload);
        if (controller) init.signal = controller.signal;
        Promise.resolve()
          .then(function () {
            return fetchImpl(base + CHAT_PATH, init);
          })
          .then(function (resp) {
            return Promise.resolve()
              .then(function () {
                return resp.json();
              })
              .catch(function () {
                return null;
              })
              .then(function (body) {
                return { status: resp.status, body: body, failure: "" };
              });
          })
          .catch(function () {
            return { status: 0, body: null, failure: timedOut ? "timeout" : "network" };
          })
          .then(function (result) {
            clearTimer(timer);
            if (!settled) {
              settled = true;
              resolve(result);
            }
          });
      });
    }

    /**
     * 把 request 的結果轉成對外格式。
     * 輸入：request 的結果。
     * 輸出：成功 { ok: true, status, data }；失敗 { ok: false, kind, status, error, data, retryAfter }。
     */
    function toResult(raw) {
      if (raw.failure) {
        return { ok: false, kind: raw.failure, status: 0, error: "", data: null, retryAfter: 0 };
      }
      if (raw.status === 200 && raw.body && typeof raw.body === "object") {
        return { ok: true, status: 200, data: raw.body };
      }
      const c = classifyError(raw.status, raw.body);
      return { ok: false, kind: c.kind, status: raw.status, error: c.error, data: raw.body, retryAfter: c.retryAfter };
    }

    /**
     * GET /api/chat：查狀態（不需通行碼，不帶自訂標頭）。
     * 輸入：無。
     * 輸出：{ online, status, data, reason }。online 只有在 200 且 status 欄位為 online 時為 true；
     *   reason 為 timeout、network、http_狀態碼、bad_body 或 not_online（給排錯，前端不依它顯示不同畫面）。
     * 失敗時：不拋例外，online 為 false。
     */
    function getStatus() {
      return request("GET", null, {}, STATUS_TIMEOUT_MS).then(function (raw) {
        if (raw.failure) return { online: false, status: 0, data: null, reason: raw.failure };
        const body = raw.body && typeof raw.body === "object" ? raw.body : null;
        if (raw.status !== 200) return { online: false, status: raw.status, data: body, reason: "http_" + raw.status };
        if (!body) return { online: false, status: raw.status, data: null, reason: "bad_body" };
        if (body.status !== "online") return { online: false, status: raw.status, data: body, reason: "not_online" };
        return { online: true, status: 200, data: body, reason: "" };
      });
    }

    /**
     * POST /api/chat：送一個回合（本體恰好 session_id、message、consent 三個欄位）。
     * 輸入：{ sessionId, message, accessCode }。
     * 輸出：toResult 的格式；成功時 data 為 TurnResponse。
     */
    function sendTurn(args) {
      const a = args || {};
      const headers = { "Content-Type": "application/json" };
      headers[ACCESS_HEADER] = String(a.accessCode || "");
      const payload = { session_id: String(a.sessionId || ""), message: String(a.message || ""), consent: true };
      return request("POST", payload, headers, TURN_TIMEOUT_MS).then(toResult);
    }

    /**
     * DELETE /api/chat：刪除這個工作階段在伺服器上的全部紀錄（本體只有 session_id）。
     * 輸入：{ sessionId, accessCode }。
     * 輸出：toResult 的格式；成功時 data 為 { deleted, session_id, counts, deleted_at }。
     */
    function deleteSession(args) {
      const a = args || {};
      const headers = { "Content-Type": "application/json" };
      headers[ACCESS_HEADER] = String(a.accessCode || "");
      return request("DELETE", { session_id: String(a.sessionId || "") }, headers, DELETE_TIMEOUT_MS).then(toResult);
    }

    return { apiBase: base, getStatus: getStatus, sendTurn: sendTurn, deleteSession: deleteSession };
  }

  return {
    CHAT_PATH: CHAT_PATH,
    ACCESS_HEADER: ACCESS_HEADER,
    STATUS_TIMEOUT_MS: STATUS_TIMEOUT_MS,
    TURN_TIMEOUT_MS: TURN_TIMEOUT_MS,
    DELETE_TIMEOUT_MS: DELETE_TIMEOUT_MS,
    normalizeBase: normalizeBase,
    classifyError: classifyError,
    createClient: createClient
  };
});
