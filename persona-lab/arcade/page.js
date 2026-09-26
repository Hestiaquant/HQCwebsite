/*
 * 街機展示頁的畫面與互動（arcade/page.js）
 *
 * 做什麼：把 engine/ 的遊戲引擎、policies/ 的策略與 engine/match.js 的批次統計接到 index.html 的畫布與按鈕上。
 *   畫圖函式改寫自原版 arcade.html 的 drawSnake（第 751 到 795 行）與 drawTetris（第 1003 到 1042 行）；
 *   自動對局迴圈改寫自原版 stepSnake 與 stepTetris，但拿掉所有後端呼叫，決策一律在瀏覽器內計算。
 *   俄羅斯方塊另有落下動畫（engine/tetris_anim.js 規劃畫格，LEE 2026-09-26 裁示）：方塊從盤面頂端出現、
 *   旋轉並移到目標欄後一列一列落下，落定後才寫進盤面；速度跟著 1x、5x、50x，50x 與減少動態效果時直接放到落點。
 * 輸入：使用者點擊與種子輸入；全域 HestiaArcade 命名空間（由前面的 script 標籤載入）。
 * 輸出：畫面更新；不寫任何瀏覽器儲存，不發任何網路請求。
 * 失敗時：必要模組缺漏時在決策紀錄顯示錯誤並停用所有開始按鈕；策略執行丟出錯誤時暫停該遊戲並記錄；
 *   行為複製策略網路的權重或特徵模組沒載入時停用該選項、退回規則專家基準線並在紀錄寫明。
 */
(function () {
  "use strict";

  // [街機] 模組檢查
  const ns = globalThis.HestiaArcade || {};
  const policiesNs = ns.policies || {};
  const missing = ["rng", "snake", "tetris", "match"].filter((k) => !ns[k]);
  if (!policiesNs.rule_snake) missing.push("policies.rule_snake");
  if (!policiesNs.rule_tetris) missing.push("policies.rule_tetris");

  // [街機] 策略登記表：bc 由 policies/bc_forward.js 依 bc_weights.js 登記；缺項時選單停用該選項
  const POLICY_TABLE = {
    snake: { rule: policiesNs.rule_snake, bc: policiesNs.bc_snake },
    tetris: { rule: policiesNs.rule_tetris, bc: policiesNs.bc_tetris },
  };

  // [街機] 各策略的說明文字（照實寫：規則是手寫的；行為複製是模仿規則專家，天花板就是規則專家）
  const POLICY_NOTES = {
    rule: "規則專家基準線是手寫的評分規則，不是訓練出來的模型。可切換成行為複製策略網路，與規則專家同台比較。",
    bc:
      "行為複製策略網路是用規則專家的對局紀錄訓練的小型多層感知器：替每個合法候選動作算一列特徵、打一個分數，選最高分。" +
      "它模仿規則專家，天花板就是規則專家；這裡展示的是模型化流程與可驗證性，不是超越規則。",
  };

  // [街機] 顯示文字
  const GAME_LABELS = { snake: "貪吃蛇", tetris: "俄羅斯方塊" };
  const END_LABELS = {
    wall: "撞牆",
    self: "撞到自己",
    illegal_action: "非法動作",
    board_full: "佔滿全盤",
    top_out: "堆到頂",
    max_steps: "達步數上限",
  };
  const SPEEDS = {
    snake: { 1: 200, 5: 45, 20: 15, 60: 2 },
    tetris: { 1: 300, 5: 60, 50: 5 },
  };
  // [街機] 俄羅斯方塊落下動畫（LEE 2026-09-26 裁示改成經典的從上方落下）：
  //   frameMs 是每一畫格的間隔；rowsPerFrame 是每格往下幾列；moveInOneFrame 把旋轉與水平移動壓成一格；
  //   instant 只畫落點一格（等同改前的直接出現），50x 用它，確保高倍速不比改前慢。
  //   SPEEDS.tetris 仍是方塊落定之後到下一塊出現的間隔，數值不變。
  const TETRIS_ANIM = {
    1: { frameMs: 40, rowsPerFrame: 1, moveInOneFrame: false, instant: false },
    5: { frameMs: 16, rowsPerFrame: 3, moveInOneFrame: true, instant: false },
    50: { frameMs: 0, rowsPerFrame: 1, moveInOneFrame: true, instant: true },
  };
  // [街機] 盤面配色：底色與格線跟著官網深色底（LEE 2026-09-26 裁示），方塊保留七色可辨識但降低彩度，與金黑米白協調
  const BOARD_BG = "#121212";
  const BOARD_GRID = "rgba(234, 231, 224, 0.07)";
  const PREVIEW_BG = "#1a1a1a";
  const PIECE_COLORS = {
    I: "#6fc3d1", O: "#D4AF37", T: "#b07cc6",
    L: "#e39a4f", J: "#6f8fd8", S: "#7fbf7f", Z: "#d9707a",
  };
  const SNAKE_HEAD = "#EAE7E0";
  const SNAKE_FOOD = "#e39a4f";
  const LATENCY_WINDOW = 50;
  const RECENT_MAX = 8;
  const BATCH_GAMES = 20;
  const BATCH_START_SEED = 1;

  // [街機] 畫面元素
  const $ = (id) => document.getElementById(id);
  const sCanvas = $("snakeCanvas");
  const sCtx = sCanvas.getContext("2d");
  const tCanvas = $("tetrisCanvas");
  const tCtx = tCanvas.getContext("2d");
  const nCanvas = $("nextPieceCanvas");
  const nCtx = nCanvas.getContext("2d");

  // [街機] 頁面狀態
  let currentGame = "snake";
  let currentPolicyId = "rule";
  let decisionWindow = 0;
  let lastTpsCheck = performance.now();
  let batchRunning = false;
  const latencies = [];
  const games = {
    snake: { engine: ns.snake, state: null, seed: 0, running: false, timer: null, speedMs: SPEEDS.snake[5], recent: [] },
    tetris: {
      engine: ns.tetris, state: null, seed: 0, running: false, timer: null, speedMs: SPEEDS.tetris[1], recent: [],
      speedKey: 1, anim: null,
    },
  };

  /**
   * 在決策紀錄加一行，最多保留 35 行（沿用原版 logToStream 的上限）。
   * 輸入：訊息字串、樣式（"ok"、"warn" 或省略）。
   * 輸出：無。
   */
  function logLine(msg, kind) {
    const terminal = $("logTerminal");
    const item = document.createElement("div");
    item.className = "log-entry" + (kind ? " " + kind : "");
    item.textContent = msg;
    terminal.appendChild(item);
    while (terminal.children.length > 35) terminal.removeChild(terminal.firstChild);
    terminal.scrollTop = terminal.scrollHeight;
  }

  /**
   * 產生新的隨機種子（只用來選局面，不涉及任何安全用途）。
   * 輸入：無。
   * 輸出：0 到 4294967295 的整數。
   */
  function freshSeed() {
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
      return globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
    }
    return Math.floor(Math.random() * 4294967296);
  }

  /**
   * 兩個遊戲的某個策略是否都已登記（行為複製需要權重、特徵與前向計算三個檔都載入）。
   * 輸入：策略代號。
   * 輸出：布林。
   */
  function policyAvailable(policyId) {
    return !!(POLICY_TABLE.snake[policyId] && POLICY_TABLE.tetris[policyId]);
  }

  /**
   * 取得指定遊戲目前選用的策略；選單值不存在時退回規則專家基準線。
   * 輸入：遊戲代號。
   * 輸出：策略物件（有 label 與 decide）。
   */
  function activePolicy(gameId) {
    const table = POLICY_TABLE[gameId];
    return table[currentPolicyId] || table.rule;
  }

  // ---------------------------------------------------------------
  // [街機] 畫圖
  // ---------------------------------------------------------------

  /**
   * 畫貪吃蛇盤面（改寫自原版 drawSnake，改讀引擎狀態）。
   * 輸入：貪吃蛇遊戲狀態。
   * 輸出：無（畫在 snakeCanvas）。
   */
  function drawSnake(state) {
    const size = state.gridSize;
    const cell = sCanvas.width / size;
    sCtx.fillStyle = BOARD_BG;
    sCtx.fillRect(0, 0, sCanvas.width, sCanvas.height);

    sCtx.strokeStyle = BOARD_GRID;
    sCtx.lineWidth = 0.5;
    for (let i = 0; i <= size; i++) {
      sCtx.beginPath();
      sCtx.moveTo(i * cell, 0);
      sCtx.lineTo(i * cell, sCanvas.height);
      sCtx.stroke();
      sCtx.beginPath();
      sCtx.moveTo(0, i * cell);
      sCtx.lineTo(sCanvas.width, i * cell);
      sCtx.stroke();
    }

    if (state.food) {
      sCtx.fillStyle = SNAKE_FOOD;
      sCtx.shadowColor = SNAKE_FOOD;
      sCtx.shadowBlur = 12;
      sCtx.beginPath();
      sCtx.arc((state.food.x + 0.5) * cell, (state.food.y + 0.5) * cell, cell * 0.4, 0, Math.PI * 2);
      sCtx.fill();
      sCtx.shadowBlur = 0;
    }

    for (let i = state.body.length - 1; i >= 0; i--) {
      const seg = state.body[i];
      if (i === 0) {
        sCtx.fillStyle = SNAKE_HEAD;
        sCtx.shadowColor = SNAKE_HEAD;
        sCtx.shadowBlur = 8;
      } else {
        // 身體由品牌金往尾端漸暗（金 212,175,55 到暗金 110,90,30）
        const ratio = i / state.body.length;
        sCtx.fillStyle =
          "rgb(" + Math.floor(212 - 102 * ratio) + ", " + Math.floor(175 - 85 * ratio) + ", " +
          Math.floor(55 - 25 * ratio) + ")";
        sCtx.shadowBlur = 0;
      }
      sCtx.fillRect(seg.x * cell + 1.5, seg.y * cell + 1.5, cell - 3, cell - 3);
    }
    sCtx.shadowBlur = 0;
  }

  /**
   * 畫俄羅斯方塊盤面、落下中的方塊與下一塊預覽（改寫自原版 drawTetris，改讀引擎狀態）。
   * 輸入：俄羅斯方塊遊戲狀態；falling 為落下中方塊的畫格 { rot, col, row }（沒有落下中的方塊時省略）。
   * 輸出：無（畫在 tetrisCanvas 與 nextPieceCanvas）。每次都先清空整個畫布再畫，不留殘影。
   */
  function drawTetris(state, falling) {
    const rows = ns.tetris.ROWS;
    const cols = ns.tetris.COLS;
    const cell = tCanvas.width / cols;
    tCtx.fillStyle = BOARD_BG;
    tCtx.fillRect(0, 0, tCanvas.width, tCanvas.height);

    tCtx.strokeStyle = BOARD_GRID;
    tCtx.lineWidth = 0.5;
    for (let c = 0; c <= cols; c++) {
      tCtx.beginPath();
      tCtx.moveTo(c * cell, 0);
      tCtx.lineTo(c * cell, tCanvas.height);
      tCtx.stroke();
    }
    for (let r = 0; r <= rows; r++) {
      tCtx.beginPath();
      tCtx.moveTo(0, r * cell);
      tCtx.lineTo(tCanvas.width, r * cell);
      tCtx.stroke();
    }

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (state.grid[r][c] === 1) {
          tCtx.fillStyle = PIECE_COLORS[state.cells[r][c]] || PIECE_COLORS.O;
          tCtx.fillRect(c * cell + 1, r * cell + 1, cell - 2, cell - 2);
        }
      }
    }

    // [街機] 落下中的方塊：目前方塊依畫格的旋轉、欄、列畫在盤面上（尚未寫進引擎盤面）
    if (falling) {
      const shape = ns.tetris.PIECES[state.current][falling.rot];
      tCtx.fillStyle = PIECE_COLORS[state.current] || PIECE_COLORS.O;
      shape.forEach(([dx, dy]) => {
        const r = falling.row + dy;
        const c = falling.col + dx;
        if (r >= 0 && r < rows && c >= 0 && c < cols) tCtx.fillRect(c * cell + 1, r * cell + 1, cell - 2, cell - 2);
      });
    }

    nCtx.fillStyle = PREVIEW_BG;
    nCtx.fillRect(0, 0, nCanvas.width, nCanvas.height);
    const nextShape = ns.tetris.PIECES[state.next][0];
    nCtx.fillStyle = PIECE_COLORS[state.next];
    nextShape.forEach(([dx, dy]) => {
      nCtx.fillRect(dx * 18 + 20, dy * 18 + 8, 16, 16);
    });
  }

  /**
   * 依遊戲種類重畫目前局面；俄羅斯方塊有落下中的方塊時一併畫出它最後顯示的位置。
   * 輸入：遊戲代號。
   * 輸出：無。
   */
  function draw(gameId) {
    const g = games[gameId];
    if (!g.state) return;
    if (gameId === "snake") drawSnake(g.state);
    else drawTetris(g.state, g.anim ? g.anim.shown : null);
  }

  // ---------------------------------------------------------------
  // [街機] 數據面板
  // ---------------------------------------------------------------

  /**
   * 更新得分與步數兩格（只更新目前分頁的遊戲）。
   * 輸入：遊戲代號。
   * 輸出：無。
   */
  function updateMetrics(gameId) {
    if (gameId !== currentGame) return;
    const g = games[gameId];
    const r = g.engine.result(g.state);
    $("valMetric1").textContent = String(r.score);
    $("valMetric2").textContent = String(r.steps);
  }

  /**
   * 記錄一次決策耗時並更新近 50 次平均。
   * 輸入：耗時毫秒。
   * 輸出：無。
   */
  function recordLatency(ms) {
    latencies.push(ms);
    if (latencies.length > LATENCY_WINDOW) latencies.shift();
    const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    $("valLatency").textContent = mean.toFixed(3);
  }

  /**
   * 重畫最近對局表。
   * 輸入：遊戲代號（只畫目前分頁）。
   * 輸出：無。
   */
  function renderRecent(gameId) {
    if (gameId !== currentGame) return;
    const body = $("recentBody");
    body.textContent = "";
    for (const row of games[gameId].recent) {
      const tr = document.createElement("tr");
      [row.seed, row.score, row.steps, END_LABELS[row.end_reason] || row.end_reason].forEach((v) => {
        const td = document.createElement("td");
        td.textContent = String(v);
        tr.appendChild(td);
      });
      body.appendChild(tr);
    }
  }

  // [街機] 每秒決策次數（沿用原版每 0.5 秒結算一次）
  setInterval(() => {
    const now = performance.now();
    const elapsed = (now - lastTpsCheck) / 1000;
    $("valTPS").textContent = Math.round(decisionWindow / elapsed) + " /s";
    decisionWindow = 0;
    lastTpsCheck = now;
  }, 500);

  // ---------------------------------------------------------------
  // [街機] 對局流程
  // ---------------------------------------------------------------

  /**
   * 以指定種子開一局新遊戲並畫出開局畫面。
   * 輸入：遊戲代號、種子。
   * 輸出：無。
   * 失敗時：種子不合法時 rng.js throw TypeError，由呼叫端先檢查。
   */
  function startGame(gameId, seed) {
    const g = games[gameId];
    // [街機] 換局時丟掉落下中的方塊（它屬於舊局面，不寫進任何盤面）；還在排程中的計時器醒來時會改從新局面決策
    if (gameId === "tetris") g.anim = null;
    g.seed = seed;
    g.state = g.engine.createGame({ rng: ns.rng.mulberry32(seed) });
    if (gameId === currentGame) $("seedInput").value = String(seed);
    draw(gameId);
    updateMetrics(gameId);
  }

  /**
   * 一局結束：記錄成績、寫紀錄，並以種子加一接著開下一局（原版是結束後立即重開）。
   * 輸入：遊戲代號。
   * 輸出：無。
   */
  function finishGame(gameId) {
    const g = games[gameId];
    const res = Object.assign({ seed: g.seed, end_reason: g.state.endReason }, g.engine.result(g.state));
    g.recent.unshift(res);
    if (g.recent.length > RECENT_MAX) g.recent.pop();
    renderRecent(gameId);
    logLine(
      "[" + GAME_LABELS[gameId] + "] 種子 " + res.seed + " 結束：" + (END_LABELS[res.end_reason] || res.end_reason) +
        "，分數 " + res.score + "，步數 " + res.steps,
      res.end_reason === "illegal_action" ? "warn" : null
    );
    startGame(gameId, (g.seed + 1) >>> 0);
  }

  // ---------------------------------------------------------------
  // [街機] 俄羅斯方塊落下動畫（只改畫面呈現）
  //   決策仍在方塊出現時算一次並計時；動畫期間不重算決策、不動亂數。播完最後一格（落點）後，
  //   才用同一個決策呼叫引擎 applyDecision，所以分數、消行、同種子同一局都和改前相同。
  //   所有計時器都呼叫 stepGame，由它判斷是播下一格還是算下一個方塊，確保同一時間只有一條計時鏈。
  // ---------------------------------------------------------------

  /**
   * 訪客系統是否開啟減少動態效果。
   * 輸入：無。輸出：布林；瀏覽器不支援 matchMedia 時回 false。
   */
  function prefersReducedMotion() {
    try {
      return typeof globalThis.matchMedia === "function" &&
        globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (err) {
      return false;
    }
  }

  /**
   * 目前速度的落下動畫設定；減少動態效果開啟或動畫模組沒載入時一律只畫落點。
   * 輸入：無。輸出：TETRIS_ANIM 的一列（可能改成 instant）。
   */
  function tetrisAnimConfig() {
    const cfg = TETRIS_ANIM[games.tetris.speedKey] || TETRIS_ANIM[1];
    if (!ns.tetrisAnim || prefersReducedMotion()) return Object.assign({}, cfg, { instant: true });
    return cfg;
  }

  /**
   * 替已判定合法的決策規劃畫格。
   * 輸入：俄羅斯方塊遊戲狀態、決策。
   * 輸出：畫格陣列；只畫落點時回空陣列（呼叫端改走直接落定）。
   * 失敗時：規劃函式丟出錯誤時回空陣列，退回直接落定，不影響對局。
   */
  function planTetrisFrames(state, decision) {
    const cfg = tetrisAnimConfig();
    if (cfg.instant) return [];
    try {
      return ns.tetrisAnim.planDrop(state.grid, state.current, decision, {
        rowsPerFrame: cfg.rowsPerFrame,
        moveInOneFrame: cfg.moveInOneFrame,
      });
    } catch (err) {
      return [];
    }
  }

  /**
   * 播落下動畫的下一格；最後一格（落點）顯示過後才寫進盤面。
   * 輸入：無（讀 games.tetris.anim）。
   * 輸出：無。執行中時排下一次 stepGame。
   */
  function advanceTetrisAnim() {
    const g = games.tetris;
    const a = g.anim;
    if (!a) return;
    const cfg = tetrisAnimConfig();
    if (cfg.instant) a.next = a.frames.length; // 動畫途中切到 50x 或開啟減少動態效果：直接到落點
    if (a.next < a.frames.length) {
      a.shown = a.frames[a.next];
      a.next += 1;
      drawTetris(g.state, a.shown);
      if (g.running) g.timer = setTimeout(() => stepGame("tetris"), cfg.frameMs);
      return;
    }
    commitTetrisAnim();
  }

  /**
   * 把落下中的方塊用原決策寫進盤面（消行、頂出、輪替都由引擎處理），再走一般的落定後流程。
   * 輸入：無。輸出：無。
   */
  function commitTetrisAnim() {
    const g = games.tetris;
    const a = g.anim;
    if (!a) return;
    g.anim = null;
    g.engine.applyDecision(g.state, a.decision);
    afterMove("tetris");
  }

  /**
   * 立刻讓落下中的方塊落定（切換策略時用）：先停掉計時器，避免兩條計時鏈同時跑。
   * 輸入：無。輸出：無；沒有落下中的方塊時不做事。
   */
  function settleTetrisAnim() {
    const g = games.tetris;
    if (!g.anim) return;
    clearTimeout(g.timer);
    commitTetrisAnim();
  }

  /**
   * 更新決策面板與決策紀錄（目前動作、計時、紀錄一行）。
   * 輸入：遊戲代號、決策、決策耗時毫秒、是否合法。
   * 輸出：無。
   */
  function reportDecision(gameId, decision, dt, legal) {
    const g = games[gameId];
    if (gameId === currentGame) {
      recordLatency(dt);
      if (!decision || typeof decision !== "object") $("valAction").textContent = "-";
      else if (gameId === "snake") $("valAction").textContent = String(decision.action);
      else $("valAction").textContent = "欄 " + decision.target_col + " · 轉 " + decision.target_rot;
    }
    if (!legal) {
      logLine("[" + GAME_LABELS[gameId] + "] 策略給出非法動作，本局結束", "warn");
    } else if (gameId === "snake" && g.state.steps % 5 === 0) {
      logLine("[貪吃蛇 " + dt.toFixed(3) + "ms] 動作 " + decision.action + " · " + decision.reason, "ok");
    } else if (gameId === "tetris") {
      logLine("[俄羅斯方塊 " + dt.toFixed(3) + "ms] " + decision.reason, "ok");
    }
  }

  /**
   * 一步落定之後：重畫、更新數字、結束時換下一局，執行中時排下一步。
   * 輸入：遊戲代號。輸出：無。
   */
  function afterMove(gameId) {
    const g = games[gameId];
    draw(gameId);
    updateMetrics(gameId);
    if (g.state.over) finishGame(gameId);
    if (g.running) g.timer = setTimeout(() => stepGame(gameId), g.speedMs);
  }

  /**
   * 自動對局的一步：觀測、在瀏覽器內計算決策並計時、推進遊戲、更新畫面，再排下一步。
   *   俄羅斯方塊有落下中的方塊時，這一步只播下一格動畫，不重算決策。
   * 輸入：遊戲代號。
   * 輸出：無。
   * 失敗時：策略丟出錯誤時暫停該遊戲並在紀錄寫出錯誤訊息。
   */
  function stepGame(gameId) {
    const g = games[gameId];
    if (!g.running) return;
    if (gameId === "tetris" && g.anim) {
      advanceTetrisAnim();
      return;
    }
    const policy = activePolicy(gameId);
    const obs = g.engine.observe(g.state);
    let decision;
    const t0 = performance.now();
    try {
      decision = policy.decide(obs);
    } catch (err) {
      setRunning(gameId, false);
      logLine("策略執行錯誤，已暫停：" + (err && err.message ? err.message : String(err)), "warn");
      return;
    }
    const dt = performance.now() - t0;
    const legal = g.engine.isLegalDecision(g.state, decision);
    decisionWindow += 1;

    // [街機] 俄羅斯方塊的合法決策：先播落下動畫，播完才寫進盤面（非法決策照舊立即結束該局）
    if (gameId === "tetris" && legal) {
      const frames = planTetrisFrames(g.state, decision);
      if (frames.length > 1) {
        reportDecision(gameId, decision, dt, legal);
        g.anim = { decision: decision, frames: frames, next: 0, shown: null };
        advanceTetrisAnim();
        return;
      }
    }

    g.engine.applyDecision(g.state, decision);
    reportDecision(gameId, decision, dt, legal);
    afterMove(gameId);
  }

  /**
   * 開始或暫停某個遊戲的自動對局，並同步按鈕文字。
   * 輸入：遊戲代號、是否執行。
   * 輸出：無。
   */
  function setRunning(gameId, running) {
    const g = games[gameId];
    g.running = running;
    clearTimeout(g.timer);
    const btn = gameId === "snake" ? $("btnSnakeToggle") : $("btnTetrisToggle");
    btn.textContent = running ? "⏸ 暫停" : "▶ 開始自動對局";
    if (running) stepGame(gameId);
  }

  /**
   * 切換分頁：暫停另一個遊戲，切換畫布、標籤、種子欄與最近對局表。
   * 輸入：遊戲代號。
   * 輸出：無。
   */
  function switchGame(gameId) {
    const other = gameId === "snake" ? "tetris" : "snake";
    if (games[other].running) setRunning(other, false);
    currentGame = gameId;
    $("tabSnake").classList.toggle("active", gameId === "snake");
    $("tabTetris").classList.toggle("active", gameId === "tetris");
    $("snakeView").classList.toggle("hidden", gameId !== "snake");
    $("tetrisView").classList.toggle("hidden", gameId !== "tetris");
    $("tetrisExtraHud").classList.toggle("hidden", gameId !== "tetris");
    $("lblMetric1").textContent = gameId === "snake" ? "得分（每個食物 10 分）" : "已消除行數";
    $("lblMetric2").textContent = gameId === "snake" ? "存活步數" : "已擺放方塊數";
    $("recentGameTag").textContent = GAME_LABELS[gameId];
    $("seedInput").value = String(games[gameId].seed);
    $("valAction").textContent = "-";
    $("hudPolicyTag").textContent = activePolicy(gameId).label;
    latencies.length = 0;
    $("valLatency").textContent = "0.000";
    updateMetrics(gameId);
    renderRecent(gameId);
  }

  /**
   * 無頭批次統計：用目前策略以種子 1 到 20 各下一局（不畫圖），每局之間讓出主執行緒避免頁面卡住。
   * 輸入：無（讀目前分頁與策略）。
   * 輸出：在 batchOut 顯示局數、結束原因、平均與 95% 信賴區間、每次決策平均耗時。
   * 失敗時：策略丟出錯誤時停止並顯示錯誤訊息。
   */
  function runBatch() {
    if (batchRunning) return;
    batchRunning = true;
    const gameId = currentGame;
    const engine = games[gameId].engine;
    const policy = activePolicy(gameId);
    const btn = $("btnBatch");
    const out = $("batchOut");
    btn.disabled = true;
    const results = [];
    let wallMs = 0;
    let decisions = 0;

    // [街機] 逐局執行，每局之間 setTimeout 讓畫面有機會更新
    const runOne = (i) => {
      if (i >= BATCH_GAMES) {
        const sum = ns.match.summarize(results);
        const reasons = Object.keys(sum.end_reasons)
          .map((k) => (END_LABELS[k] || k) + " " + sum.end_reasons[k])
          .join("、");
        out.textContent =
          GAME_LABELS[gameId] + " · " + policy.label + " · 種子 " + BATCH_START_SEED + " 到 " + (BATCH_START_SEED + BATCH_GAMES - 1) + "\n" +
          "局數 " + sum.games + "，結束原因：" + reasons + "\n" +
          "平均分數 " + sum.score.mean.toFixed(1) + "（95% 信賴區間 " + sum.score.ci95_low.toFixed(1) + " 到 " + sum.score.ci95_high.toFixed(1) + "）\n" +
          "平均步數 " + sum.steps.mean.toFixed(1) + "\n" +
          "每次決策平均 " + (decisions > 0 ? (wallMs / decisions).toFixed(4) : "0") + " 毫秒（總耗時除以決策次數，含遊戲推進）\n" +
          "非法動作 " + sum.illegal_total + " 次";
        btn.disabled = false;
        batchRunning = false;
        return;
      }
      out.textContent = "執行中：第 " + (i + 1) + " 局，共 " + BATCH_GAMES + " 局";
      setTimeout(() => {
        try {
          const t0 = performance.now();
          const r = ns.match.playGame(engine, policy, { seed: BATCH_START_SEED + i });
          wallMs += performance.now() - t0;
          decisions += r.decisions;
          results.push(r);
          runOne(i + 1);
        } catch (err) {
          out.textContent = "批次統計失敗：" + (err && err.message ? err.message : String(err));
          btn.disabled = false;
          batchRunning = false;
        }
      }, 0);
    };
    runOne(0);
  }

  /**
   * 綁定所有按鈕與輸入欄的事件，並開出兩個遊戲的第一局。
   * 輸入：無。
   * 輸出：無。
   */
  function init() {
    $("tabSnake").addEventListener("click", () => switchGame("snake"));
    $("tabTetris").addEventListener("click", () => switchGame("tetris"));
    $("btnSnakeToggle").addEventListener("click", () => setRunning("snake", !games.snake.running));
    $("btnTetrisToggle").addEventListener("click", () => setRunning("tetris", !games.tetris.running));
    $("btnSnakeReset").addEventListener("click", () => startGame("snake", freshSeed()));
    $("btnTetrisReset").addEventListener("click", () => startGame("tetris", freshSeed()));
    $("btnBatch").addEventListener("click", runBatch);

    // [街機] 速度按鈕
    ["snake", "tetris"].forEach((gameId) => {
      const group = $(gameId + "Speeds");
      group.querySelectorAll(".btn-speed").forEach((btn) => {
        btn.addEventListener("click", () => {
          group.querySelectorAll(".btn-speed").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          games[gameId].speedMs = SPEEDS[gameId][btn.dataset.speed];
          games[gameId].speedKey = Number(btn.dataset.speed);
        });
      });
    });

    // [街機] 以指定種子重開
    $("btnReplaySeed").addEventListener("click", () => {
      const seed = Number($("seedInput").value);
      if (!ns.rng.isValidSeed(seed)) {
        logLine("種子必須是 0 到 4294967295 的整數", "warn");
        return;
      }
      startGame(currentGame, seed);
      logLine("[" + GAME_LABELS[currentGame] + "] 以種子 " + seed + " 重開");
    });

    // [街機] 策略選單：行為複製沒載入時停用該選項；不存在的策略退回規則專家基準線
    const bcOption = $("policySelect").querySelector('option[value="bc"]');
    if (bcOption && !policyAvailable("bc")) {
      bcOption.disabled = true;
      logLine("行為複製策略網路的權重沒有載入，選單只保留規則專家基準線", "warn");
    }
    $("policySelect").addEventListener("change", (ev) => {
      // [街機] 落下中的方塊是舊策略的決策：先讓它立刻落定，新策略從下一個方塊起生效，畫面不留半途的方塊
      settleTetrisAnim();
      const wanted = ev.target.value;
      if (!policyAvailable(wanted)) {
        ev.target.value = "rule";
        currentPolicyId = "rule";
        logLine("所選策略不可用，維持規則專家基準線", "warn");
      } else {
        currentPolicyId = wanted;
        logLine("切換策略：" + activePolicy(currentGame).label + "（下一步起生效，目前這局繼續）");
      }
      latencies.length = 0;
      $("valLatency").textContent = "0.000";
      $("hudPolicyTag").textContent = activePolicy(currentGame).label;
      $("policyNote").textContent = POLICY_NOTES[currentPolicyId] || POLICY_NOTES.rule;
    });

    if (!ns.tetrisAnim) logLine("俄羅斯方塊落下動畫模組未載入，方塊改為直接出現在落點", "warn");

    startGame("snake", freshSeed());
    startGame("tetris", freshSeed());
    switchGame("snake");
  }

  // [街機] 入口：模組缺漏時停用開始按鈕，不改呼叫後端
  if (missing.length > 0) {
    logLine("模組載入失敗，無法開始：" + missing.join("、"), "warn");
    ["btnSnakeToggle", "btnTetrisToggle", "btnSnakeReset", "btnTetrisReset", "btnReplaySeed", "btnBatch"].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = true;
    });
    return;
  }
  init();
})();
