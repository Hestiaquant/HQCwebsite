/*
 * 街機展示頁的畫面與互動（arcade/page.js）
 *
 * 做什麼：把 engine/ 的遊戲引擎、policies/ 的策略與 engine/match.js 的批次統計接到 index.html 的畫布與按鈕上。
 *   畫圖函式改寫自原版 arcade.html 的 drawSnake（第 751 到 795 行）與 drawTetris（第 1003 到 1042 行）；
 *   自動對局迴圈改寫自原版 stepSnake 與 stepTetris，但拿掉所有後端呼叫，決策一律在瀏覽器內計算。
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
  const PIECE_COLORS = {
    I: "#00f0ff", O: "#ffd166", T: "#b5179e",
    L: "#ff9e00", J: "#4361ee", S: "#4ade80", Z: "#ef476f",
  };
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
    tetris: { engine: ns.tetris, state: null, seed: 0, running: false, timer: null, speedMs: SPEEDS.tetris[1], recent: [] },
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
    sCtx.fillStyle = "#07090f";
    sCtx.fillRect(0, 0, sCanvas.width, sCanvas.height);

    sCtx.strokeStyle = "rgba(47, 54, 74, 0.3)";
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
      sCtx.fillStyle = "#ffaa00";
      sCtx.shadowColor = "#ff6a00";
      sCtx.shadowBlur = 12;
      sCtx.beginPath();
      sCtx.arc((state.food.x + 0.5) * cell, (state.food.y + 0.5) * cell, cell * 0.4, 0, Math.PI * 2);
      sCtx.fill();
      sCtx.shadowBlur = 0;
    }

    for (let i = state.body.length - 1; i >= 0; i--) {
      const seg = state.body[i];
      if (i === 0) {
        sCtx.fillStyle = "#00f0ff";
        sCtx.shadowColor = "#00f0ff";
        sCtx.shadowBlur = 8;
      } else {
        const ratio = i / state.body.length;
        sCtx.fillStyle =
          "rgb(" + Math.floor(46 * (1 - ratio)) + ", " + Math.floor(196 * (1 - ratio * 0.4)) + ", " +
          Math.floor(182 + ratio * 50) + ")";
        sCtx.shadowBlur = 0;
      }
      sCtx.fillRect(seg.x * cell + 1.5, seg.y * cell + 1.5, cell - 3, cell - 3);
    }
    sCtx.shadowBlur = 0;
  }

  /**
   * 畫俄羅斯方塊盤面與下一塊預覽（改寫自原版 drawTetris，改讀引擎狀態）。
   * 輸入：俄羅斯方塊遊戲狀態。
   * 輸出：無（畫在 tetrisCanvas 與 nextPieceCanvas）。
   */
  function drawTetris(state) {
    const rows = ns.tetris.ROWS;
    const cols = ns.tetris.COLS;
    const cell = tCanvas.width / cols;
    tCtx.fillStyle = "#07090f";
    tCtx.fillRect(0, 0, tCanvas.width, tCanvas.height);

    tCtx.strokeStyle = "rgba(47, 54, 74, 0.3)";
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
          tCtx.fillStyle = PIECE_COLORS[state.cells[r][c]] || "#ffd166";
          tCtx.fillRect(c * cell + 1, r * cell + 1, cell - 2, cell - 2);
        }
      }
    }

    nCtx.fillStyle = "#111420";
    nCtx.fillRect(0, 0, nCanvas.width, nCanvas.height);
    const nextShape = ns.tetris.PIECES[state.next][0];
    nCtx.fillStyle = PIECE_COLORS[state.next];
    nextShape.forEach(([dx, dy]) => {
      nCtx.fillRect(dx * 18 + 20, dy * 18 + 8, 16, 16);
    });
  }

  /**
   * 依遊戲種類重畫目前局面。
   * 輸入：遊戲代號。
   * 輸出：無。
   */
  function draw(gameId) {
    const g = games[gameId];
    if (!g.state) return;
    if (gameId === "snake") drawSnake(g.state);
    else drawTetris(g.state);
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

  /**
   * 自動對局的一步：觀測、在瀏覽器內計算決策並計時、推進遊戲、更新畫面，再排下一步。
   * 輸入：遊戲代號。
   * 輸出：無。
   * 失敗時：策略丟出錯誤時暫停該遊戲並在紀錄寫出錯誤訊息。
   */
  function stepGame(gameId) {
    const g = games[gameId];
    if (!g.running) return;
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
    g.engine.applyDecision(g.state, decision);
    decisionWindow += 1;

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

    draw(gameId);
    updateMetrics(gameId);
    if (g.state.over) finishGame(gameId);
    if (g.running) g.timer = setTimeout(() => stepGame(gameId), g.speedMs);
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
