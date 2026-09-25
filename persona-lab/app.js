/*
 * 展示頁互動邏輯（showcase_frontend/app.js）
 *
 * 做什麼：對話頁的畫面切換與互動，依 spec/05 契約第七章：
 *   1. 載入時與每 60 秒查一次狀態；5 秒沒回應或 503 就切到時段外畫面，只顯示公布時段與一句說明，不播任何預錄內容。
 *   2. 首次告知：localStorage 的 hestia_consent_version 與後端 consent_version 不同就顯示告知，按我了解才開放輸入；
 *      按先不開始只關掉告知、輸入框維持鎖住，刪除我的對話仍可使用。
 *   3. 通行碼由訪客輸入，只存 sessionStorage（分頁關閉即消失），不存 localStorage。
 *   4. 工作階段編號用 crypto.randomUUID 產生，存 localStorage 的 hestia_session_id。
 *   5. 送出回合後，在每則回覆旁畫出標註面板：內在狀態名稱、PAD 三軸、表情四態、意圖與各類機率、need_rag、
 *      情緒強度、合規攔截與理由、記憶引用與寫入、檢索段落編號與章名、各階段延遲。
 *   6. 刪除我的對話：DELETE 後顯示筆數，清掉兩個 localStorage 鍵並重新產生工作階段編號。
 *      對話畫面與時段外畫面都可刪除（契約 1.3 刪除不受時段限制）；沒有通行碼時在刪除區塊內輸入。
 * 輸入：瀏覽器的 document、儲存區與 config.js 的 HESTIA_SHOWCASE_CONFIG；後端呼叫一律經 api.js。
 * 輸出：畫面更新；本檔不發任何網路請求。
 * 失敗時：儲存區不可用（例如隱私模式）時改存在記憶體，功能照常但關閉分頁就遺失；
 *   頁面缺少必要元素時在主控台記錄並停止啟動，不會改用其他後端或播放預錄內容；
 *   回覆欄位缺漏時該列顯示無資料，不會中斷整則回覆的顯示。
 * 載入方式：瀏覽器用一般 script 標籤載入（掛在 globalThis.HestiaShowcase.view 與 .app）；Node 測試用 require。
 */
(function (root, factory) {
  "use strict";
  // [前端] 通用模組包裝：Node 走 module.exports，瀏覽器掛到 HestiaShowcase 命名空間並自動啟動
  const mod = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = mod;
  } else {
    const ns = (root.HestiaShowcase = root.HestiaShowcase || {});
    ns.view = mod.view;
    ns.app = mod;
    mod.autoStart(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  // [前端] 儲存鍵與契約常數（spec/05 第一章、第七章）
  const LS_SESSION = "hestia_session_id";
  const LS_CONSENT = "hestia_consent_version";
  const SS_ACCESS = "hestia_access_code";
  const DEFAULT_CONSENT_VERSION = "2026-09-23";
  const MAX_CHARS = 500;
  const MAX_BODY_BYTES = 4096;
  const POLL_MS = 60000;
  const SUPPORTED_CONTRACT_MAJOR = "1";

  // [前端] 顯示用名稱表（內容對照 spec/05 第四、五章與 spec/labels/labels_v1.json）
  const STATE_NAMES = { calm: "平靜", warm: "溫暖", stern: "嚴肅", worried: "擔憂", elated: "振奮" };
  const EXPRESSIONS = { SMILE: "微笑", STERN: "認真", PONDER: "思索", SURPRISE: "驚訝" };
  const INTENT_CLASSES = [
    { key: "greeting_smalltalk", name: "問候與社交應對" },
    { key: "concept_question", name: "課程觀念提問" },
    { key: "advice_request", name: "投資建議或明牌請求" },
    { key: "injection_extraction", name: "提示注入或套取內部資訊" },
    { key: "emotional_venting", name: "情緒傾訴" },
    { key: "out_of_scope", name: "範圍外話題" },
    { key: "misconception_challenge", name: "誤解陳述或觀念質疑" }
  ];
  const STAGES = { pre: "直覺層前檢", llm_self: "理解層自評", post: "輸出後檢" };
  const REASONS = {
    advice_request: "直覺層判為投資建議請求",
    injection: "直覺層判為提示注入或套取內部資訊",
    llm_self_advice: "理解層自評為投資建議請求",
    post_canary: "回覆含內部哨兵字串",
    post_prompt_overlap: "回覆與系統提示重疊過高",
    post_ticker_action: "回覆含標的加買賣動作",
    post_price_level: "回覆含價位或點位數字",
    post_profit_claim: "回覆含效果型用語",
    post_persona_switch: "回覆出現身分切換",
    post_internal_info: "回覆提到內部設定",
    post_forbidden_term: "回覆含其他禁用詞",
    post_check_error: "後檢程式出錯，依規則一律攔截",
    self_harm_risk: "偵測到自傷或傷人風險，改用危機協議回應"
  };
  const TEMPLATES = {
    advice: "投資建議類婉拒",
    internal: "內部資訊類婉拒",
    off_topic: "範圍外引導",
    unavailable: "暫時無法回答",
    crisis: "危機協議回應（附求助專線）"
  };
  const DEGRADED = {
    model_missing: "模型檔缺漏",
    manifest_mismatch: "模型清單不符",
    tokenizer_missing: "斷詞器缺漏",
    session_init_failed: "推論環境建立失敗",
    nan_output: "輸出含非數值",
    inference_error: "推論錯誤",
    empty_input: "輸入為空白"
  };
  const TIERS = { long: "長期", mid: "中期", short: "短期" };
  const LATENCY_KEYS = [
    ["queue_wait", "排隊等待"],
    ["intuition", "直覺層"],
    ["compliance_pre", "合規前檢"],
    ["memory_read", "記憶讀取"],
    ["rag", "知識庫檢索"],
    ["llm", "語言模型"],
    ["compliance_post", "合規後檢"],
    ["emotion", "情緒計算"],
    ["memory_write", "記憶寫入"],
    ["core_total", "核心合計"],
    ["total", "閘道總計"]
  ];
  const NO_DATA = "無資料";

  /**
   * 判斷是否為標準 8-4-4-4-12 UUID。
   * 輸入：任意值。輸出：布林；不會拋例外。
   */
  function isUuid(value) {
    return typeof value === "string" && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
  }

  /**
   * 產生新的工作階段編號（小寫 UUID v4）。
   * 輸入：crypto 物件（瀏覽器的 globalThis.crypto）。
   * 輸出：UUID 字串；優先用 crypto.randomUUID，瀏覽器不支援時用 crypto.getRandomValues 自組 v4。
   * 失敗時：兩者都沒有時拋 Error，因為不能用 Math.random 產生可猜的編號。
   */
  function makeUuid(cryptoObj) {
    if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
      return String(cryptoObj.randomUUID()).toLowerCase();
    }
    if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
      const b = cryptoObj.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const hex = Array.from(b, function (x) {
        return (x + 0x100).toString(16).slice(1);
      }).join("");
      return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
    }
    throw new Error("crypto_unavailable");
  }

  /**
   * 以 Unicode 字元（碼位）計算字數，與後端 Python 的 len 一致。
   * 輸入：字串。輸出：整數。
   */
  function countChars(text) {
    return Array.from(String(text || "")).length;
  }

  /**
   * 計算字串以 UTF-8 編碼後的位元組數（對照後端 max_body_bytes 4096，待辦 T3）。
   * 輸入：字串。輸出：整數。
   */
  function utf8Length(text) {
    const s = String(text || "");
    if (typeof TextEncoder === "function") return new TextEncoder().encode(s).length;
    let n = 0;
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    }
    return n;
  }

  /** 數值或 null。輸入：任意值。輸出：有限數字時原值，否則 null。 */
  function num(v) {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }

  /** 物件或空物件。輸入：任意值。輸出：一般物件時原值，否則 {}。 */
  function obj(v) {
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  }

  /** 字串或空字串。輸入：任意值。輸出：字串時原值，否則空字串。 */
  function str(v) {
    return typeof v === "string" ? v : "";
  }

  /**
   * 帶正負號的小數格式（PAD 用）。
   * 輸入：數字或 null、小數位數。輸出：例如 +0.30、-0.10、0.00；null 時為無資料。
   */
  function fmtSigned(v, digits) {
    const n = num(v);
    if (n === null) return NO_DATA;
    const d = typeof digits === "number" ? digits : 2;
    const fixed = Math.abs(n).toFixed(d);
    if (Number(fixed) === 0) return (0).toFixed(d);
    return (n > 0 ? "+" : "-") + fixed;
  }

  /** 機率轉百分比（小數一位）。輸入：0 到 1 的數字。輸出：例如 88.0%；非數字時為無資料。 */
  function fmtPercent(v) {
    const n = num(v);
    return n === null ? NO_DATA : (n * 100).toFixed(1) + "%";
  }

  /** 毫秒格式（千分位）。輸入：數字。輸出：例如 6,511 毫秒；非數字時為無資料。 */
  function fmtMs(v) {
    const n = num(v);
    if (n === null) return NO_DATA;
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " 毫秒";
  }

  /**
   * 公布時段的顯示文字。
   * 輸入：config 或後端給的原字串，例如 09:00-23:00。
   * 輸出：HH:MM-HH:MM 格式時轉成 每天 09:00 到 23:00（台灣時間）；空字串時為 尚未公布；其他原樣顯示。
   */
  function fmtHours(text) {
    const s = str(text).trim();
    if (!s) return "尚未公布";
    const m = /^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/.exec(s);
    if (m) return "每天 " + m[1] + " 到 " + m[2] + "（台灣時間）";
    return s;
  }

  /** 是否文字。輸入：布林或其他。輸出：是、否或無資料。 */
  function yesNo(v, yes, no) {
    if (v === true) return yes || "是";
    if (v === false) return no || "否";
    return NO_DATA;
  }

  /**
   * 把 TurnResponse 轉成標註面板要顯示的資料（純函式，不碰 DOM）。
   * 輸入：POST 200 的回應本體（spec/05 1.2）；欄位可缺漏。
   * 輸出：{ reply, head: { expressionCode, expressionText, blocked, turnText, contractNote },
   *   summary, sections: [{ key, title, rows }] }。row 為 { label, text } 或 { label, bars } 或 { label, list }。
   * 失敗時：不拋例外；缺漏欄位顯示無資料，未知代碼原樣顯示。
   */
  function annotationModel(resp) {
    const r = obj(resp);
    const e = obj(r.emotion);
    const pad = obj(e.pad);
    const it = obj(r.intent);
    const c = obj(r.compliance);
    const mem = obj(r.memory);
    const rag = obj(r.rag);
    const lat = obj(r.latency_ms);

    // [前端] 情緒與表情（S1：狀態名稱、PAD 三軸、表情四態）
    const stateCode = str(e.state_code);
    const stateName = str(e.state_name) || STATE_NAMES[stateCode] || "";
    const exprCode = Object.prototype.hasOwnProperty.call(EXPRESSIONS, e.expression) ? e.expression : "";
    const exprText = exprCode ? exprCode + " " + EXPRESSIONS[exprCode] : str(e.expression) || NO_DATA;
    const sugg = str(e.llm_suggested_expression);
    const emotionRows = [
      { label: "內在狀態", text: stateName ? stateName + (stateCode ? "（" + stateCode + "）" : "") : NO_DATA },
      {
        label: "PAD 三軸",
        bars: [
          ["愉悅 P", pad.pleasure],
          ["喚起 A", pad.arousal],
          ["支配 D", pad.dominance]
        ].map(function (p) {
          const v = num(p[1]);
          return { name: p[0], value: v === null ? 0 : Math.max(-1, Math.min(1, v)), min: -1, max: 1, text: fmtSigned(v, 2), highlight: false };
        })
      },
      { label: "表情", text: exprText },
      {
        label: "理解層建議表情",
        text: (sugg ? sugg + (EXPRESSIONS[sugg] ? " " + EXPRESSIONS[sugg] : "") : "無") + "（只記錄，不參與決定）"
      }
    ];

    // [前端] 直覺層意圖
    const choice = Number.isInteger(it.choice) ? it.choice : null;
    const cls = choice !== null && INTENT_CLASSES[choice] ? INTENT_CLASSES[choice] : null;
    const intentCode = str(it.choice_code) || (cls ? cls.key : "");
    const intentName = cls ? cls.name : intentCode || NO_DATA;
    const intentRows = [{ label: "判定意圖", text: intentCode && cls ? intentName + "（" + intentCode + "）" : intentName }];
    if (Array.isArray(it.probs) && it.probs.length > 0) {
      intentRows.push({
        label: "各類機率",
        bars: it.probs.map(function (p, i) {
          const v = num(p);
          const name = INTENT_CLASSES[i] ? INTENT_CLASSES[i].name : "類別 " + i;
          return { name: name, value: v === null ? 0 : Math.max(0, Math.min(1, v)), min: 0, max: 1, text: fmtPercent(v), highlight: i === choice };
        })
      });
    } else {
      intentRows.push({ label: "各類機率", text: NO_DATA });
    }
    intentRows.push({
      label: "需要查知識庫",
      text: yesNo(it.need_rag) + (num(it.need_rag_prob) !== null ? "（機率 " + fmtPercent(it.need_rag_prob) + "）" : "")
    });
    intentRows.push({ label: "情緒強度", text: num(it.emotion_intensity) === null ? NO_DATA : it.emotion_intensity.toFixed(2) });
    intentRows.push({
      label: "值得寫入長期記憶",
      text: yesNo(it.memory_worthy) + (num(it.memory_worthy_prob) !== null ? "（機率 " + fmtPercent(it.memory_worthy_prob) + "）" : "")
    });
    let sourceText = NO_DATA;
    if (it.source === "intuition") sourceText = "直覺層分類器";
    else if (it.source === "degraded") {
      const reason = str(it.degraded_reason);
      sourceText = "保守路徑（直覺層失效：" + (DEGRADED[reason] ? DEGRADED[reason] + " " + reason : reason || NO_DATA) + "）";
    } else if (str(it.source)) sourceText = str(it.source);
    intentRows.push({ label: "判定來源", text: sourceText });
    intentRows.push({ label: "直覺層推論", text: fmtMs(it.latency_ms) });
    if (str(it.label_set_version)) intentRows.push({ label: "標籤版本", text: str(it.label_set_version) });

    // [前端] 合規閘
    const blocked = c.blocked === true;
    const stage = str(c.stage);
    const reason = str(c.reason_code);
    const tpl = str(c.template_kind);
    const complianceRows = [
      { label: "結果", text: c.blocked === undefined ? NO_DATA : blocked ? "攔截" : "放行" },
      { label: "攔截層", text: stage ? (STAGES[stage] || stage) + "（" + stage + "）" : "無" },
      { label: "理由", text: reason ? (REASONS[reason] ? REASONS[reason] + "（" + reason + "）" : reason) : "無" },
      { label: "婉拒範本", text: tpl ? (TEMPLATES[tpl] ? TEMPLATES[tpl] + "（" + tpl + "）" : tpl) : "未使用" },
      { label: "加嚴後檢", text: yesNo(c.strict_mode) }
    ];

    // [前端] 記憶
    const used = Array.isArray(mem.used) ? mem.used : [];
    const written = Array.isArray(mem.written) ? mem.written : [];
    const memoryRows = [
      { label: "記憶層", text: mem.available === undefined ? NO_DATA : mem.available ? "可用" : "本回合不可用" },
      {
        label: "本回合引用",
        list: used.map(function (m) {
          const x = obj(m);
          const parts = [(TIERS[x.tier] || str(x.tier) || "未標層") + "記憶", str(x.text) || NO_DATA];
          if (num(x.strength) !== null) parts.push("強度 " + x.strength.toFixed(2));
          if (num(x.similarity) !== null) parts.push("相似度 " + x.similarity.toFixed(2));
          return parts.join(" · ");
        })
      },
      {
        label: "本回合寫入",
        list: written.map(function (m) {
          const x = obj(m);
          return (TIERS[x.tier] || str(x.tier) || "未標層") + "記憶 · " + (str(x.text) || NO_DATA);
        })
      }
    ];

    // [前端] 知識庫檢索
    const cites = Array.isArray(rag.citations) ? rag.citations : [];
    const ragRows = [
      { label: "本回合查詢", text: yesNo(rag.queried) },
      { label: "索引", text: yesNo(rag.available, "可用", "不可用") },
      { label: "向量訊號", text: rag.degraded === true ? "缺席（只用字面檢索）" : rag.degraded === false ? "正常" : NO_DATA },
      { label: "題外判定", text: yesNo(rag.off_topic) },
      {
        label: "引用段落",
        list: cites.map(function (ci) {
          const x = obj(ci);
          const chapter = Number.isInteger(x.chapter) ? "第 " + x.chapter + " 章" : "";
          return [str(x.paragraph_id) || NO_DATA, [chapter, str(x.chapter_title)].filter(Boolean).join(" ")]
            .filter(Boolean)
            .join(" · ");
        })
      }
    ];

    // [前端] 各階段延遲（spec/05 4.3 的鍵與順序）
    const latencyRows = [];
    LATENCY_KEYS.forEach(function (pair) {
      if (Object.prototype.hasOwnProperty.call(lat, pair[0])) {
        latencyRows.push({ label: pair[1], text: fmtMs(lat[pair[0]]) });
      }
    });
    if (latencyRows.length === 0) latencyRows.push({ label: "延遲", text: NO_DATA });

    const version = str(r.contract_version);
    const major = version.split(".")[0];
    const summary = [
      "意圖 " + intentName,
      blocked ? "合規攔截" : "合規放行",
      "記憶引用 " + used.length + " 筆",
      "引用段落 " + cites.length + " 段",
      "總延遲 " + fmtMs(lat.total)
    ].join(" · ");

    return {
      reply: str(r.reply) || "（沒有回覆內容）",
      head: {
        expressionCode: exprCode,
        expressionText: exprText,
        blocked: blocked,
        turnText: Number.isInteger(r.turn_index) ? "第 " + r.turn_index + " 回合" : "",
        contractNote: version && major !== SUPPORTED_CONTRACT_MAJOR ? "回應契約版本 " + version + "，部分欄位可能無法顯示" : ""
      },
      summary: summary,
      sections: [
        { key: "emotion", title: "情緒與表情", rows: emotionRows },
        { key: "intent", title: "直覺層意圖", rows: intentRows },
        { key: "compliance", title: "合規閘", rows: complianceRows },
        { key: "memory", title: "記憶", rows: memoryRows },
        { key: "rag", title: "知識庫檢索", rows: ragRows },
        { key: "latency", title: "各階段延遲", rows: latencyRows }
      ]
    };
  }

  const view = {
    LS_SESSION: LS_SESSION,
    LS_CONSENT: LS_CONSENT,
    SS_ACCESS: SS_ACCESS,
    DEFAULT_CONSENT_VERSION: DEFAULT_CONSENT_VERSION,
    MAX_CHARS: MAX_CHARS,
    MAX_BODY_BYTES: MAX_BODY_BYTES,
    POLL_MS: POLL_MS,
    INTENT_CLASSES: INTENT_CLASSES,
    isUuid: isUuid,
    makeUuid: makeUuid,
    countChars: countChars,
    utf8Length: utf8Length,
    fmtSigned: fmtSigned,
    fmtPercent: fmtPercent,
    fmtMs: fmtMs,
    fmtHours: fmtHours,
    annotationModel: annotationModel
  };

  /**
   * 包一層安全的儲存區：讀寫失敗（隱私模式、被封鎖）時改用記憶體。
   * 輸入：回傳 Storage 的函式（取用本身可能拋 SecurityError）。
   * 輸出：{ get, set, remove }；不會拋例外。
   */
  function makeStore(getStorage) {
    let backing = null;
    try {
      backing = getStorage() || null;
    } catch (err) {
      backing = null;
    }
    const mem = {};
    return {
      get: function (key) {
        try {
          if (backing) return backing.getItem(key);
        } catch (err) {
          /* 改讀記憶體 */
        }
        return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null;
      },
      set: function (key, value) {
        try {
          if (backing) {
            backing.setItem(key, String(value));
            return;
          }
        } catch (err) {
          /* 改寫記憶體 */
        }
        mem[key] = String(value);
      },
      remove: function (key) {
        try {
          if (backing) backing.removeItem(key);
        } catch (err) {
          /* 記憶體仍要清 */
        }
        delete mem[key];
      }
    };
  }

  // [前端] 頁面必要元素的 id（showcase_frontend/index.html）
  const ELEMENT_IDS = {
    screenLoading: "screen-loading",
    screenOffline: "screen-offline",
    screenChat: "screen-chat",
    offlineHours: "offline-hours",
    sessionLabel: "session-label",
    accessForm: "access-form",
    accessInput: "access-code",
    accessError: "access-error",
    accessOk: "access-ok",
    accessChange: "access-change",
    chatLog: "chat-log",
    chatNotice: "chat-notice",
    chatForm: "chat-form",
    chatInput: "chat-input",
    chatSend: "chat-send",
    chatCounter: "chat-counter",
    consentOverlay: "consent-overlay",
    consentAccept: "consent-accept",
    consentLater: "consent-later",
    consentReopenBox: "consent-reopen-box",
    consentReopen: "consent-reopen",
    deleteZone: "delete-zone",
    deleteBtn: "delete-btn",
    deleteAccessForm: "delete-access-form",
    deleteAccessInput: "delete-access-code",
    deleteConfirm: "delete-confirm",
    deleteYes: "delete-yes",
    deleteNo: "delete-no",
    deleteResult: "delete-result"
  };

  /**
   * 啟動對話頁。
   * 輸入：env（可省略，測試時注入）：document、localStorage、sessionStorage、crypto、fetch、
   *   setTimeout、clearTimeout、setInterval、clearInterval、AbortController、now、config、api。
   * 輸出：控制物件 { state, refreshStatus, stop }（給測試與除錯用）；頁面缺元素時回 null。
   * 失敗時：缺必要元素或缺 api.js 時在主控台記錄並回 null，不發任何請求。
   */
  function start(envIn) {
    const g = root || {};
    const env = Object.assign(
      {
        document: g.document,
        crypto: g.crypto,
        fetch: typeof g.fetch === "function" ? g.fetch.bind(g) : null,
        setTimeout: g.setTimeout ? g.setTimeout.bind(g) : null,
        clearTimeout: g.clearTimeout ? g.clearTimeout.bind(g) : null,
        setInterval: g.setInterval ? g.setInterval.bind(g) : null,
        clearInterval: g.clearInterval ? g.clearInterval.bind(g) : null,
        AbortController: g.AbortController,
        now: function () {
          return Date.now();
        },
        config: g.HESTIA_SHOWCASE_CONFIG || {},
        api: g.HestiaShowcase ? g.HestiaShowcase.api : null
      },
      envIn || {}
    );
    const doc = env.document;
    const log = g.console || { error: function () {} };
    if (!doc || !env.api) {
      log.error("[展示頁] 缺少 document 或 api.js，停止啟動");
      return null;
    }

    // [前端] 取得頁面元素；缺任何一個就停止
    const el = {};
    const missing = [];
    Object.keys(ELEMENT_IDS).forEach(function (k) {
      el[k] = doc.getElementById(ELEMENT_IDS[k]);
      if (!el[k]) missing.push(ELEMENT_IDS[k]);
    });
    if (missing.length) {
      log.error("[展示頁] 頁面缺少元素：" + missing.join("、"));
      return null;
    }

    const local = makeStore(function () {
      return "localStorage" in env ? env.localStorage : g.localStorage;
    });
    const session = makeStore(function () {
      return "sessionStorage" in env ? env.sessionStorage : g.sessionStorage;
    });
    const config = env.config || {};
    const client = env.api.createClient({
      apiBase: config.API_BASE,
      fetchImpl: env.fetch,
      setTimeout: env.setTimeout,
      clearTimeout: env.clearTimeout,
      AbortControllerImpl: env.AbortController
    });

    const state = {
      screen: "loading",
      sessionId: "",
      accessCode: session.get(SS_ACCESS) || "",
      serverConsentVersion: "",
      serverHours: "",
      consented: false,
      awaitingRestart: false,
      sending: false,
      deleting: false,
      waitUntil: 0,
      statusInFlight: false,
      timers: { poll: null, wait: null, pending: null }
    };

    /** 建立元素並設定類名與文字。輸入：標籤、類名、文字。輸出：元素。 */
    function h(tag, className, text) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    }

    /** 移除元素的所有子節點。輸入：元素。輸出：無。 */
    function clearChildren(node) {
      while (node.firstChild) node.removeChild(node.firstChild);
    }

    /** 捲到元素（瀏覽器不支援時略過）。輸入：元素。輸出：無。 */
    function reveal(node) {
      if (node && typeof node.scrollIntoView === "function") {
        try {
          node.scrollIntoView({ block: "nearest" });
        } catch (err) {
          /* 舊瀏覽器不支援參數時略過 */
        }
      }
    }

    /** 讓元素取得焦點（元素不可見時略過）。輸入：元素。輸出：無。 */
    function focusOn(node) {
      if (node && typeof node.focus === "function") {
        try {
          node.focus();
        } catch (err) {
          /* 略過 */
        }
      }
    }

    // [前端] 工作階段編號：localStorage 沒有或格式不對就重新產生
    /** 產生或沿用工作階段編號並顯示前 8 碼。輸入：無。輸出：無（寫 state.sessionId）。失敗時：crypto 不可用時 makeUuid 拋錯，啟動中止。 */
    function ensureSession() {
      let id = local.get(LS_SESSION);
      if (!isUuid(id)) {
        id = makeUuid(env.crypto);
        local.set(LS_SESSION, id);
      }
      state.sessionId = String(id).toLowerCase();
      el.sessionLabel.textContent = state.sessionId.slice(0, 8);
    }

    // [前端] 提示列
    /** 在提示列顯示訊息。輸入：文字、色調（warn 或空字串）。輸出：無。 */
    function showNotice(text, tone) {
      el.chatNotice.textContent = text;
      el.chatNotice.className = "notice" + (tone ? " notice-" + tone : "");
      el.chatNotice.hidden = false;
    }

    /** 隱藏並清空提示列。輸入：無。輸出：無。 */
    function hideNotice() {
      el.chatNotice.hidden = true;
      el.chatNotice.textContent = "";
    }

    /** 在刪除區塊顯示結果文字。輸入：文字。輸出：無。 */
    function showDeleteResult(text) {
      el.deleteResult.textContent = text;
      el.deleteResult.hidden = false;
    }

    // [前端] 按鈕與輸入框狀態，每次狀態改變後呼叫
    /** 依目前狀態更新輸入框、送出與刪除按鈕、通行碼區塊、字數。輸入：無。輸出：無。 */
    function updateControls() {
      const waiting = state.waitUntil > env.now();
      const ready = state.screen === "chat" && state.consented && !state.sending && !waiting;
      const text = el.chatInput.value.trim();
      el.chatInput.disabled = !ready;
      el.chatSend.disabled = !ready || !state.accessCode || countChars(text) === 0;
      const canDelete = state.screen === "chat" || state.screen === "offline";
      el.deleteZone.hidden = !canDelete;
      el.deleteBtn.disabled = !canDelete || state.deleting || state.sending || waiting;
      if (state.accessCode) el.deleteAccessForm.hidden = true;
      el.accessForm.hidden = !!state.accessCode;
      el.accessOk.hidden = !state.accessCode;
      el.consentReopenBox.hidden = !(state.screen === "chat" && state.awaitingRestart && !state.consented);
      const n = countChars(text);
      el.chatCounter.textContent = n + " / " + MAX_CHARS;
      el.chatCounter.className = "counter" + (n > MAX_CHARS ? " counter-over" : "");
    }

    // [前端] 畫面切換：loading、offline、chat 三選一
    /** 切換畫面（loading、offline、chat 三選一）；離開對話畫面時一併關閉告知。輸入：畫面名稱。輸出：無。 */
    function showScreen(name) {
      state.screen = name;
      el.screenLoading.hidden = name !== "loading";
      el.screenOffline.hidden = name !== "offline";
      el.screenChat.hidden = name !== "chat";
      if (name !== "chat") hideConsent();
      updateControls();
    }

    // [前端] 時段外畫面：只顯示公布時段與一句說明
    /** 切到時段外畫面，只顯示公布時段（config 優先，其次後端給的值）。輸入：後端給的 public_hours。輸出：無。 */
    function showOffline(hoursFromServer) {
      el.offlineHours.textContent = fmtHours(str(config.PUBLIC_HOURS) || str(hoursFromServer) || state.serverHours);
      showScreen("offline");
    }

    // [前端] 首次告知
    /** 顯示首次告知（只在對話畫面）。輸入：無。輸出：無。 */
    function showConsent() {
      if (state.screen !== "chat") return;
      el.consentOverlay.hidden = false;
      focusOn(el.consentAccept);
    }

    /** 隱藏首次告知。輸入：無。輸出：無。 */
    function hideConsent() {
      el.consentOverlay.hidden = true;
    }

    /** 比對 localStorage 的告知版本與後端版本，不同就顯示告知（訪客按過先不開始時不自動跳出）。輸入：無。輸出：無。 */
    function syncConsent() {
      const wanted = state.serverConsentVersion || DEFAULT_CONSENT_VERSION;
      state.consented = local.get(LS_CONSENT) === wanted;
      if (state.consented) hideConsent();
      else if (!state.awaitingRestart) showConsent();
      updateControls();
    }

    /** 按我了解：記下告知版本並開放輸入。輸入：無。輸出：無。失敗時：儲存區不可用時改記在記憶體。 */
    function acceptConsent() {
      local.set(LS_CONSENT, state.serverConsentVersion || DEFAULT_CONSENT_VERSION);
      state.consented = true;
      state.awaitingRestart = false;
      hideConsent();
      updateControls();
      focusOn(state.accessCode ? el.chatInput : el.accessInput);
    }

    // [前端] 先不開始：關掉告知但不同意，輸入框維持鎖住；刪除我的對話仍可使用（刪除權不以同意新告知為前提）
    function deferConsent() {
      state.awaitingRestart = true;
      hideConsent();
      updateControls();
      focusOn(el.consentReopen);
    }

    // [前端] 狀態輪詢（GET 不需通行碼）
    /** 查一次狀態並切換畫面；前一次還沒回來時不重複送。輸入：無。輸出：Promise（不會 reject）。失敗時：任何錯誤都切到時段外畫面。 */
    function refreshStatus() {
      if (state.statusInFlight) return Promise.resolve();
      state.statusInFlight = true;
      return client
        .getStatus()
        .then(function (res) {
          state.statusInFlight = false;
          if (!res || !res.online) {
            showOffline(res && res.data ? res.data.public_hours : "");
            return;
          }
          state.serverConsentVersion = str(res.data.consent_version) || DEFAULT_CONSENT_VERSION;
          state.serverHours = str(res.data.public_hours);
          showScreen("chat");
          syncConsent();
        })
        .catch(function () {
          state.statusInFlight = false;
          showOffline("");
        });
    }

    // [前端] 通行碼：只存 sessionStorage
    /** 通行碼表單送出：存進 sessionStorage。輸入：submit 事件。輸出：無。失敗時：空白時顯示請輸入通行碼。 */
    function onAccessSubmit(ev) {
      if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
      const code = el.accessInput.value.trim();
      if (!code) {
        el.accessError.textContent = "請輸入通行碼";
        el.accessError.hidden = false;
        return;
      }
      session.set(SS_ACCESS, code);
      state.accessCode = code;
      el.accessInput.value = "";
      el.accessError.hidden = true;
      updateControls();
      focusOn(el.chatInput);
    }

    /** 清掉通行碼並要求重新輸入。輸入：要顯示的錯誤訊息（空字串表示不顯示）。輸出：無。 */
    function forgetAccessCode(message) {
      session.remove(SS_ACCESS);
      state.accessCode = "";
      el.accessInput.value = "";
      if (message) {
        el.accessError.textContent = message;
        el.accessError.hidden = false;
      } else {
        el.accessError.hidden = true;
      }
      updateControls();
      focusOn(el.accessInput);
    }

    // [前端] 等待倒數（429 與 503 queue_* 依 retry_after_seconds；說明文字依錯誤碼）
    const WAIT_REASONS = {
      auth_locked: "通行碼錯誤次數過多，暫時鎖定",
      quota_exceeded: "已達使用次數上限",
      queue_full: "目前排隊的人較多",
      queue_timeout: "排隊等候逾時"
    };

    /** 開始倒數，倒數期間不能送出或刪除。輸入：秒數、錯誤碼（決定說明文字）。輸出：無。 */
    function startWait(seconds, code) {
      const reason = WAIT_REASONS[code] || "目前使用的人較多";
      state.waitUntil = env.now() + seconds * 1000;
      if (state.timers.wait !== null) env.clearInterval(state.timers.wait);
      const tick = function () {
        const left = Math.ceil((state.waitUntil - env.now()) / 1000);
        if (left > 0) {
          showNotice(reason + "，請在 " + left + " 秒後再送出。", "warn");
        } else {
          env.clearInterval(state.timers.wait);
          state.timers.wait = null;
          state.waitUntil = 0;
          showNotice("可以重新送出了。", "");
        }
        updateControls();
      };
      state.timers.wait = env.setInterval(tick, 1000);
      tick();
    }

    // [前端] 訪客訊息與回覆的畫面元素
    /** 在對話紀錄加入訪客訊息（送出中樣式）。輸入：訊息文字。輸出：article 元素。 */
    function appendUserMessage(text) {
      const art = h("article", "turn turn-user pending");
      art.appendChild(h("p", "bubble-user", text));
      el.chatLog.appendChild(art);
      reveal(art);
      return art;
    }

    /** 加入等待回覆的提示並每秒更新已等待秒數。輸入：無。輸出：article 元素。 */
    function appendPending() {
      const art = h("article", "turn turn-wait");
      const p = h("p", "wait-text", "赫斯提亞正在回覆");
      art.appendChild(p);
      el.chatLog.appendChild(art);
      const startedAt = env.now();
      state.timers.pending = env.setInterval(function () {
        const s = Math.floor((env.now() - startedAt) / 1000);
        p.textContent = "赫斯提亞正在回覆，已等待 " + s + " 秒";
      }, 1000);
      reveal(art);
      return art;
    }

    /** 停止等待計時並移除等待提示。輸入：等待提示元素。輸出：無。 */
    function clearPending(node) {
      if (state.timers.pending !== null) {
        env.clearInterval(state.timers.pending);
        state.timers.pending = null;
      }
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }

    /** 畫一列標註。輸入：row。輸出：[dt, dd] 兩個元素。 */
    function renderRow(row) {
      const wide = !!(row.bars || row.list);
      const dt = h("dt", "annot-label" + (wide ? " annot-wide" : ""), row.label);
      const dd = h("dd", "annot-value" + (wide ? " annot-wide" : ""));
      if (row.bars) {
        const wrap = h("div", "bars");
        row.bars.forEach(function (b) {
          const line = h("div", "bar-row" + (b.highlight ? " bar-hit" : ""));
          line.appendChild(h("span", "bar-name", b.name));
          const track = h("span", "bar-track" + (b.min < 0 ? " bar-signed" : ""));
          const fill = h("span", "bar-fill" + (b.value < 0 ? " bar-neg" : ""));
          const span = b.max - b.min;
          const zero = b.min < 0 ? ((0 - b.min) / span) * 100 : 0;
          const at = ((b.value - b.min) / span) * 100;
          fill.style.left = Math.min(zero, at).toFixed(2) + "%";
          fill.style.width = Math.abs(at - zero).toFixed(2) + "%";
          track.appendChild(fill);
          line.appendChild(track);
          line.appendChild(h("span", "bar-val", b.text));
          wrap.appendChild(line);
        });
        dd.appendChild(wrap);
      } else if (row.list) {
        if (row.list.length === 0) {
          dd.textContent = "無";
        } else {
          const ul = h("ul", "annot-list");
          row.list.forEach(function (t) {
            ul.appendChild(h("li", "", t));
          });
          dd.appendChild(ul);
        }
      } else {
        dd.textContent = row.text;
      }
      return [dt, dd];
    }

    /** 畫一個標註區塊。輸入：section。輸出：section 元素。 */
    function renderSection(sec) {
      const box = h("section", "annot-sec annot-" + sec.key);
      box.appendChild(h("h3", "annot-title", sec.title));
      const dl = h("dl", "annot-grid");
      sec.rows.forEach(function (row) {
        renderRow(row).forEach(function (n) {
          dl.appendChild(n);
        });
      });
      box.appendChild(dl);
      return box;
    }

    /** 畫一則回覆與旁邊的標註面板。輸入：TurnResponse。輸出：article 元素。 */
    function renderReply(data) {
      const model = annotationModel(data);
      const art = h("article", "turn turn-reply" + (model.head.blocked ? " is-blocked" : ""));
      const main = h("div", "reply");
      const head = h("div", "reply-head");
      head.appendChild(h("span", "speaker", "赫斯提亞"));
      head.appendChild(h("span", "expr expr-" + (model.head.expressionCode || "none"), model.head.expressionText));
      if (model.head.blocked) head.appendChild(h("span", "tag tag-blocked", "合規攔截"));
      if (model.head.turnText) head.appendChild(h("span", "turn-no", model.head.turnText));
      main.appendChild(head);
      main.appendChild(h("p", "reply-text", model.reply));
      if (model.head.contractNote) main.appendChild(h("p", "contract-note", model.head.contractNote));
      art.appendChild(main);

      const aside = h("aside", "annot");
      aside.setAttribute("aria-label", "本則回覆的標註");
      aside.appendChild(renderSection(model.sections[0]));
      const more = h("details", "annot-more");
      more.open = true;
      more.appendChild(h("summary", "annot-summary", model.summary));
      model.sections.slice(1).forEach(function (sec) {
        more.appendChild(renderSection(sec));
      });
      aside.appendChild(more);
      art.appendChild(aside);
      return art;
    }

    // [前端] 送出一個回合
    /** 送出一個回合：檢查告知、通行碼、字數與位元組上限後呼叫 api.sendTurn。輸入：submit 或 keydown 事件。輸出：無。失敗時：交給 handleFailure 分流，訊息留在輸入框。 */
    function onSend(ev) {
      if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
      if (state.sending || state.screen !== "chat") return;
      if (!state.consented) {
        showConsent();
        return;
      }
      if (!state.accessCode) {
        showNotice("請先輸入通行碼。", "warn");
        focusOn(el.accessInput);
        return;
      }
      if (state.waitUntil > env.now()) return;
      const text = el.chatInput.value.trim();
      const n = countChars(text);
      if (n < 1) return;
      if (n > MAX_CHARS) {
        showNotice("訊息最多 " + MAX_CHARS + " 字，目前 " + n + " 字。", "warn");
        return;
      }
      const bodyBytes = utf8Length(JSON.stringify({ session_id: state.sessionId, message: text, consent: true }));
      if (bodyBytes > MAX_BODY_BYTES) {
        showNotice("訊息內容過長，請縮短後再送出。", "warn");
        return;
      }
      state.sending = true;
      hideNotice();
      updateControls();
      const userNode = appendUserMessage(text);
      const pendingNode = appendPending();
      client.sendTurn({ sessionId: state.sessionId, message: text, accessCode: state.accessCode }).then(function (res) {
        state.sending = false;
        clearPending(pendingNode);
        if (res.ok) {
          userNode.className = "turn turn-user";
          const reply = renderReply(res.data);
          el.chatLog.appendChild(reply);
          el.chatInput.value = "";
          reveal(reply);
          updateControls();
          focusOn(el.chatInput);
          return;
        }
        if (userNode.parentNode) userNode.parentNode.removeChild(userNode);
        handleFailure(res, "send");
        updateControls();
      });
    }

    // [前端] 失敗分流（spec/05 第七章）
    /** 依 api.js 的 kind 分流顯示（契約第七章）。輸入：失敗結果、動作（send 或 delete）。輸出：無。 */
    function handleFailure(res, action) {
      const kind = res.kind;
      if (kind === "unauthorized") {
        forgetAccessCode("通行碼不正確，請重新輸入。");
        if (action === "delete") showDeleteResult("通行碼不正確，刪除沒有執行。");
        return;
      }
      if (kind === "paused") {
        if (action === "delete") showDeleteResult("目前暫停服務，刪除沒有執行，請稍後再試。");
        showOffline(res.data ? res.data.public_hours : "");
        return;
      }
      if (kind === "wait") {
        startWait(res.retryAfter || 10, res.error);
        if (action === "delete") showDeleteResult("目前請求較多，刪除沒有執行，請稍後再按一次。");
        return;
      }
      if (action === "delete") {
        showDeleteResult(
          kind === "network" || kind === "timeout" ? "連線失敗，刪除沒有完成，請稍後再試。" : "刪除沒有完成，請稍後再試。"
        );
        if (kind === "network") refreshStatus();
        return;
      }
      if (kind === "consent_required") {
        local.remove(LS_CONSENT);
        if (res.data && str(res.data.consent_version)) state.serverConsentVersion = res.data.consent_version;
        state.consented = false;
        state.awaitingRestart = false;
        showConsent();
        return;
      }
      const messages = {
        too_large: "訊息內容過大，請縮短後再送出。",
        invalid: "訊息格式不符，請確認長度在 1 到 500 字之間。",
        not_ready: "對話核心尚未就緒，請稍後再試。",
        timeout: "等候回覆逾時，請稍後再試。",
        network: "連線中斷，正在重新確認展示狀態。"
      };
      showNotice(messages[kind] || "暫時無法回應，請稍後再試。", "warn");
      if (kind === "network") refreshStatus();
    }

    // [前端] 刪除我的對話（DELETE）
    /** 按刪除我的對話：沒有通行碼時在刪除區塊內顯示通行碼欄位（時段外畫面沒有上方的通行碼表單），否則顯示確認。輸入：無。輸出：無。 */
    function onDeleteClick() {
      if (!state.accessCode) {
        el.deleteConfirm.hidden = true;
        el.deleteAccessForm.hidden = false;
        showDeleteResult("刪除需要通行碼，請先輸入通行碼。");
        focusOn(el.deleteAccessInput);
        return;
      }
      el.deleteAccessForm.hidden = true;
      el.deleteConfirm.hidden = false;
      focusOn(el.deleteYes);
    }

    /** 刪除區塊的通行碼表單送出：存進 sessionStorage（與上方通行碼同一個鍵），接著顯示刪除確認。輸入：submit 事件。輸出：無。失敗時：空白時提示請輸入通行碼，不送任何請求。 */
    function onDeleteAccessSubmit(ev) {
      if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
      const code = el.deleteAccessInput.value.trim();
      if (!code) {
        showDeleteResult("請輸入通行碼。");
        focusOn(el.deleteAccessInput);
        return;
      }
      session.set(SS_ACCESS, code);
      state.accessCode = code;
      el.deleteAccessInput.value = "";
      el.deleteAccessForm.hidden = true;
      el.deleteResult.hidden = true;
      updateControls();
      el.deleteConfirm.hidden = false;
      focusOn(el.deleteYes);
    }

    /** 確認刪除：呼叫 api.deleteSession，成功後顯示筆數、清掉兩個 localStorage 鍵並重新產生工作階段編號。輸入：無。輸出：無。失敗時：交給 handleFailure，工作階段不變。 */
    function onDeleteConfirm() {
      el.deleteConfirm.hidden = true;
      state.deleting = true;
      updateControls();
      showDeleteResult("正在刪除。");
      client.deleteSession({ sessionId: state.sessionId, accessCode: state.accessCode }).then(function (res) {
        state.deleting = false;
        if (res.ok) {
          const counts = obj(res.data && res.data.counts);
          const c = function (k) {
            return Number.isInteger(counts[k]) ? String(counts[k]) : "0";
          };
          showDeleteResult(
            "已刪除這個工作階段在伺服器上的紀錄：對話 " + c("turns") + " 回合、記憶 " + c("memories") + " 筆、事件 " + c("events") + " 筆。"
          );
          local.remove(LS_SESSION);
          local.remove(LS_CONSENT);
          ensureSession();
          clearChildren(el.chatLog);
          state.consented = false;
          state.awaitingRestart = true;
          hideNotice();
        } else {
          handleFailure(res, "delete");
        }
        updateControls();
      });
    }

    // [前端] 事件綁定（頁內沒有行內腳本，全部在這裡綁）
    el.accessForm.addEventListener("submit", onAccessSubmit);
    el.accessChange.addEventListener("click", function () {
      forgetAccessCode("");
    });
    el.chatForm.addEventListener("submit", onSend);
    el.chatInput.addEventListener("input", updateControls);
    el.chatInput.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
        onSend(ev);
      }
    });
    el.consentAccept.addEventListener("click", acceptConsent);
    el.consentLater.addEventListener("click", deferConsent);
    el.consentReopen.addEventListener("click", function () {
      state.awaitingRestart = false;
      updateControls();
      showConsent();
    });
    el.deleteBtn.addEventListener("click", onDeleteClick);
    el.deleteAccessForm.addEventListener("submit", onDeleteAccessSubmit);
    el.deleteYes.addEventListener("click", onDeleteConfirm);
    el.deleteNo.addEventListener("click", function () {
      el.deleteConfirm.hidden = true;
    });

    ensureSession();
    showScreen("loading");
    const firstCheck = refreshStatus();
    state.timers.poll = env.setInterval(refreshStatus, POLL_MS);

    return {
      state: state,
      ready: firstCheck,
      refreshStatus: refreshStatus,
      stop: function () {
        ["poll", "wait", "pending"].forEach(function (k) {
          if (state.timers[k] !== null) env.clearInterval(state.timers[k]);
          state.timers[k] = null;
        });
      }
    };
  }

  /**
   * 瀏覽器自動啟動：DOM 準備好後呼叫 start。
   * 輸入：全域物件。輸出：無。
   * 失敗時：沒有 document（Node）或設了 HESTIA_SHOWCASE_NO_AUTOSTART（測試）時不啟動。
   */
  function autoStart(g) {
    if (!g || !g.document || g.HESTIA_SHOWCASE_NO_AUTOSTART) return;
    const run = function () {
      start();
    };
    if (g.document.readyState === "loading") g.document.addEventListener("DOMContentLoaded", run);
    else run();
  }

  return { view: view, start: start, autoStart: autoStart, ELEMENT_IDS: ELEMENT_IDS };
});
