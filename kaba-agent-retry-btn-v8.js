/**
 * KABA Agent Retry Button v1.0.2
 * - 注入位置：所有 `.ui-prompt-input-toolbar`，每个 toolbar 内独立一对按钮
 *   - 主按钮：胶囊形 + 橙色 + 文字「卡吧司机」
 *   - 副按钮：圆形 + 眼睛图标 = 「驻留监测」开关
 * - 状态：每个 toolbar 独立（WeakMap） · 切 chat 不互相影响
 * - 驻留监测：开启后，全局 MutationObserver 监听账单/限流弹窗
 *   出现时找当前可见的 toolbar（且其 guarding=true 且 active=false），自动 start()
 * - 驻留开关持久化到 sessionStorage（用 toolbar 文本签名做 key，reload 不丢）
 *
 * 全局 API：
 *   window.__kabaRetryV9 = {
 *     listToolbars(), getState(toolbar), start(toolbar), stop(toolbar),
 *     toggleGuard(toolbar), diagnose()
 *   }
 *   window.__kabaRetryV9Cleanup()
 *
 * 向后兼容老 API（v8）：window.__kabaRetryV8.* 仍指向当前激活 toolbar 的对应方法
 */
(function () {
  "use strict";

  // 旧实例清理
  if (window.__kabaRetryV9Cleanup) { try { window.__kabaRetryV9Cleanup(); } catch (_) {} }
  if (window.__kabaRetryV8Cleanup) { try { window.__kabaRetryV8Cleanup(); } catch (_) {} }

  var BTN_CLASS = "kaba-retry-v9-btn";
  var GUARD_CLASS = "kaba-retry-v9-guard";
  var CSS_ID = "__kaba_retry_v9_css";
  var STORE_KEY = "__kaba_retry_v9_guard_state";
  var BRAND_COLOR = "#F97316";
  var BRAND_BG_HOVER = "rgba(249,115,22,0.18)";
  var BRAND_BG_ACTIVE = "rgba(249,115,22,0.28)";
  var BTN_LABEL = "卡吧司机";
  var LOG = "[KabaRetryV9]";

  var CFG = {
    SEND_TIMEOUT_MS: 10000,
    GONE_TIMEOUT_MS: 8000,
    GONE_RETRY_TIMEOUT_MS: 20000,
    STABLE_ABSENT_MS: 360,
    STABLE_ABSENT_MAX_MS: 6000,
    STABLE_VISIBLE_MS: 480,
    REAPPEAR_TIMEOUT_MS: 10000,
    MAX_RETRIES: 50,
    GUARD_TRIGGER_DEBOUNCE_MS: 800,
  };

  function log() {
    try { console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments))); } catch (_) {}
  }

  // ── 胜利音效 (Web Audio API 合成) ────────────────────────
  function playVictorySound() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx = new AC();
      var notes = [523.25, 659.25, 783.99, 1046.50]; // C5-E5-G5-C6
      var durations = [0.15, 0.15, 0.15, 0.4];
      var t = ctx.currentTime;
      for (var i = 0; i < notes.length; i++) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = notes[i];
        gain.gain.setValueAtTime(0.15, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + durations[i] * 0.9);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + durations[i]);
        t += durations[i];
      }
      setTimeout(function () { ctx.close(); }, 2000);
    } catch (_) {}
  }

  // ── 持久化层 ───────────────────────────────────────────────
  function loadGuardStorage() {
    try {
      var raw = sessionStorage.getItem(STORE_KEY);
      if (!raw) return {};
      return JSON.parse(raw) || {};
    } catch (_) { return {}; }
  }
  function saveGuardStorage(obj) {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(obj || {})); } catch (_) {}
  }
  function toolbarSignature(toolbar) {
    if (!toolbar) return "";
    var text = (toolbar.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100);
    var modelEl = toolbar.querySelector(".ui-model-picker__trigger");
    var modelText = modelEl ? (modelEl.textContent || "").replace(/\s+/g, " ").trim().slice(0, 50) : "";
    return "tb|" + modelText + "|" + text;
  }

  // ── SVG ────────────────────────────────────────────────
  function createIconSvg() {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 1024 1024");
    svg.setAttribute("width", "16"); svg.setAttribute("height", "16");
    svg.style.display = "block"; svg.style.flexShrink = "0";
    function p(d, fill) {
      var el = document.createElementNS(ns, "path");
      el.setAttribute("d", d); el.setAttribute("fill", fill);
      return el;
    }
    svg.appendChild(p("M512 0C229.2736 0 0 229.2736 0 512s229.2736 512 512 512 512-229.2736 512-512S794.7264 0 512 0z", BRAND_COLOR));
    svg.appendChild(p("M253.3376 589.6704l-1.3312-3.7888-0.768-2.3552-0.3584-0.9728-1.1264-3.2256-0.256-0.9216 12.3904 35.9936-12.9536-37.632-0.8704-2.56-0.256-0.5632-0.3584-1.0752-0.4608-1.28-0.1024-0.256h0.0512l-0.6144-1.7408-0.256-0.6144-0.512-1.536v-0.1024l-0.256-0.7168v-0.1536l0.256 0.8704-0.4608-2.7648a9.216 9.216 0 0 1 6.144-8.704l51.9168-17.92a9.216 9.216 0 0 1 11.6224 5.6832l14.848 43.2128a186.2144 186.2144 0 0 0 41.5232 62.976 187.648 187.648 0 1 0-23.3472-236.9536 36.5568 36.5568 0 1 1-60.7744-40.7552A260.096 260.096 0 0 1 503.8592 256a260.8128 260.8128 0 1 1-240.9984 360.6528l-0.512-0.8704a9.1648 9.1648 0 0 1-0.3072-0.8192l-0.2048-0.6144-1.1776-3.328-2.4064-6.3488a259.072 259.072 0 0 1-3.9936-12.1344l-0.2048-0.6656-0.768-2.2528 0.5632 1.4848-0.512-1.4336z", "#FFFFFF"));
    svg.appendChild(p("M239.872 404.7872l56.3712-144.5888a20.48 20.48 0 0 1 35.84-4.3008l98.816 141.0048a20.48 20.48 0 0 1-16.384 32.256l-155.136 3.5328a20.48 20.48 0 0 1-19.5072-27.904z", "#FFFFFF"));
    return svg;
  }
  function createEyeSvg() {
    /* 简易"眼睛"图标：椭圆 + 瞳孔 */
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16"); svg.setAttribute("height", "16");
    svg.style.display = "block"; svg.style.flexShrink = "0";
    var p1 = document.createElementNS(ns, "path");
    p1.setAttribute("d", "M12 5C7 5 2.7 8.1 1 12c1.7 3.9 6 7 11 7s9.3-3.1 11-7c-1.7-3.9-6-7-11-7zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z");
    p1.setAttribute("fill", "currentColor");
    var c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "2.4");
    c.setAttribute("fill", "currentColor");
    svg.appendChild(p1); svg.appendChild(c);
    return svg;
  }

  function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    var s = document.createElement("style");
    s.id = CSS_ID;
    s.textContent =
      "@keyframes kaba-retry-v9-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}" +
      "@keyframes kaba-retry-v9-pulse{0%,100%{opacity:1}50%{opacity:0.35}}";
    document.head.appendChild(s);
  }

  // ── DOM 探测 ───────────────────────────────────────────
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    var r = el.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return false;
    var cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  }
  function listToolbars() {
    try {
      var ctx = (typeof document !== "undefined") ? document : null;
      if (!ctx || typeof ctx.querySelectorAll !== "function") return [];
      var nodes = ctx.querySelectorAll(".ui-prompt-input-toolbar");
      return Array.prototype.slice.call(nodes);
    } catch (_) { return []; }
  }
  function findToolbarSubmit(toolbar) {
    if (!toolbar) return null;
    return toolbar.querySelector(".ui-prompt-input-submit-button") ||
           toolbar.querySelector(".send-with-mode .anysphere-icon-button") ||
           toolbar.querySelector("button");
  }
  function findToolbarModelTrigger(toolbar) {
    if (!toolbar) return null;
    return toolbar.querySelector(".ui-model-picker__trigger");
  }
  function findToolbarStickyBubble(toolbar) {
    /* sticky bubble 是全局的，不一定属于哪个 toolbar；以 toolbar 关联的 chat 为粗略边界寻找 */
    try {
      var popup = findBillingPopup();
      if (popup) {
        var b = popup.closest && popup.closest('[data-message-role="human"]');
        if (b) return b;
      }
      var all = document.querySelectorAll(".composer-sticky-human-message");
      if (all.length) return all[all.length - 1];
    } catch (_) {}
    return null;
  }
  function findBillingPopup() {
    var sels = [
      ".ui-notification-tray",
      ".agent-panel-followup-header-tray-stack",
      ".ui-tray-stack",
      ".composer-warning-popup",
      ".composer-usage-limit-popover",
    ];
    for (var i = 0; i < sels.length; i++) {
      try {
        var nodes = document.querySelectorAll(sels[i]);
        for (var j = nodes.length - 1; j >= 0; j--) {
          if (isVisible(nodes[j])) return nodes[j];
        }
      } catch (_) {}
    }
    return null;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ── 状态管理（每个 toolbar 独立） ───────────────────────
  var stateMap = new WeakMap();
  function getState(toolbar) {
    if (!toolbar) return null;
    if (!stateMap.has(toolbar)) {
      var sig = toolbarSignature(toolbar);
      var storage = loadGuardStorage();
      var stored = storage[sig] || {};
      stateMap.set(toolbar, {
        active: false,
        count: 0,
        guarding: !!stored.guarding,
        loopHandle: null,
        guardTriggerAt: 0,
      });
    }
    return stateMap.get(toolbar);
  }
  function persistGuard(toolbar) {
    var s = getState(toolbar);
    var sig = toolbarSignature(toolbar);
    var storage = loadGuardStorage();
    if (s.guarding) storage[sig] = { guarding: true };
    else delete storage[sig];
    saveGuardStorage(storage);
  }

  // ── 发送/重试核心（按 toolbar 域）────────────────────────
  function clickSubmit(toolbar) {
    var btn = findToolbarSubmit(toolbar);
    if (!btn) return false;
    // 防止录音按钮 (编辑器空时按钮变为录音)
    if (btn.querySelector('[data-testid="mic"]')) {
      log('submit btn is mic, skip');
      return false;
    }
    // 确认编辑器有内容 (防止触发 Multitasking Queue)
    var ed = document.querySelector('.ProseMirror');
    if (ed && (ed.textContent || '').trim().length < 2) {
      log('editor empty, skip submit');
      return false;
    }
    btn.click();
    return true;
  }

  async function sendTopForToolbar(toolbar) {
    var bubble = findToolbarStickyBubble(toolbar);
    if (!bubble) return clickSubmit(toolbar);
    var msgBox = bubble.querySelector(".composer-human-message");
    if (msgBox) msgBox.click(); else bubble.click();
    var editor = null;
    for (var i = 0; i < 15 && !editor; i++) {
      await sleep(200);
      editor = bubble.querySelector('.aislash-editor-input[contenteditable="true"]');
    }
    if (!editor) return clickSubmit(toolbar);
    var sendBtn = null;
    for (var j = 0; j < 10 && !sendBtn; j++) {
      await sleep(200);
      sendBtn = bubble.querySelector(".send-with-mode .anysphere-icon-button") || bubble.querySelector(".ui-prompt-input-submit-button");
    }
    if (sendBtn) {
      // 防止录音按钮
      if (sendBtn.querySelector && sendBtn.querySelector('[data-testid="mic"]')) return false;
      sendBtn.click(); return true;
    }
    editor.focus();
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    return true;
  }

  function waitForBilling(timeoutMs) {
    return new Promise(function (resolve) {
      if (findBillingPopup()) return resolve(true);
      var done = false, ob = null, tid = null;
      function finish(r) {
        if (done) return; done = true;
        if (ob) ob.disconnect(); if (tid) clearTimeout(tid);
        resolve(r);
      }
      ob = new MutationObserver(function () { if (findBillingPopup()) finish(true); });
      ob.observe(document.body, { childList: true, subtree: true });
      tid = setTimeout(function () { finish(false); }, timeoutMs);
    });
  }
  function waitForBillingGone(timeoutMs) {
    return new Promise(function (resolve) {
      if (!findBillingPopup()) return resolve(true);
      var done = false, ob = null, tid = null;
      function finish(r) {
        if (done) return; done = true;
        if (ob) ob.disconnect(); if (tid) clearTimeout(tid);
        resolve(r);
      }
      ob = new MutationObserver(function () { if (!findBillingPopup()) finish(true); });
      ob.observe(document.body, { childList: true, subtree: true });
      tid = setTimeout(function () { finish(false); }, timeoutMs);
    });
  }
  function waitStableAbsent(minAbsentMs, maxWaitMs) {
    return new Promise(function (resolve) {
      var t0 = Date.now(), since = null;
      (function tick() {
        var has = !!findBillingPopup();
        var now = Date.now();
        if (now - t0 > maxWaitMs) return resolve(false);
        if (!has) {
          if (since == null) since = now;
          if (now - since >= minAbsentMs) return resolve(true);
        } else since = null;
        setTimeout(tick, 40);
      })();
    });
  }
  function waitForBillingStableReappear(timeoutMs, stableVisibleMs) {
    return new Promise(function (resolve) {
      var t0 = Date.now(), since = null;
      (function tick() {
        var has = !!findBillingPopup();
        var now = Date.now();
        if (now - t0 > timeoutMs) return resolve(false);
        if (has) {
          if (since == null) since = now;
          if (now - since >= stableVisibleMs) return resolve(true);
        } else since = null;
        setTimeout(tick, 40);
      })();
    });
  }

  // ── AI 回复检测 (v1.0.2 增强) ─────────────────────────────
  var INVALID_REPLIES = ['cursor.com/dashboard', 'pay your invoice', 'resume requests', 'Visit cursor'];
  function countAiMessages() {
    return document.querySelectorAll('[data-message-role="ai"]').length;
  }
  function getLastAiText() {
    var els = document.querySelectorAll('[data-message-role="ai"]');
    return els.length > 0 ? els[els.length - 1].textContent.trim().slice(0, 500) : '';
  }
  function isRealAiReply(text, baseText) {
    if (!text || text.length < 10) return false;
    if (text === baseText) return false;
    for (var i = 0; i < INVALID_REPLIES.length; i++) {
      if (text.indexOf(INVALID_REPLIES[i]) >= 0) return false;
    }
    return true;
  }
  function isEditorEmpty() {
    var ed = document.querySelector('.ProseMirror');
    if (!ed) return false;
    return (ed.textContent || '').trim().length < 2;
  }
  function waitForNewAi(baseCount, baseText, timeoutMs) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function tick() {
        var c = countAiMessages();
        var t = getLastAiText();
        if (c > baseCount && isRealAiReply(t, baseText)) return resolve(t);
        // 编辑器空 = 消息已被接受处理中, 额外等待检测
        if (isEditorEmpty() && c > baseCount) {
          if (isRealAiReply(t, baseText)) return resolve(t);
        }
        if (Date.now() - t0 > timeoutMs) return resolve(null);
        setTimeout(tick, 400);
      })();
    });
  }
  function waitAiStable(initialText, maxMs) {
    return new Promise(function (resolve) {
      var last = initialText, stable = 0, t0 = Date.now();
      (function tick() {
        var t = getLastAiText();
        if (t === last) { stable++; if (stable >= 3) return resolve(last); }
        else { last = t; stable = 0; }
        if (Date.now() - t0 > maxMs) return resolve(last);
        setTimeout(tick, 1500);
      })();
    });
  }

  // ── 三通道成功检测 (v1.0.2) ───────────────────────────────
  // 通道1: 弹窗消失 + 无新弹窗 = 可能成功
  // 通道2: AI 回复数量增加 + 内容有效 = 确定成功
  // 通道3: 编辑器清空 + AI 回复出现 = 消息已被接受
  function raceDetect(baseAiCount, baseAiText, timeoutMs) {
    return new Promise(function (resolve) {
      var t0 = Date.now(), done = false;
      function finish(result) {
        if (done) return; done = true;
        resolve(result);
      }
      (function tick() {
        if (done) return;
        var now = Date.now();
        if (now - t0 > timeoutMs) return finish({ type: 'timeout' });
        // 通道2: AI 回复检测 (最可靠)
        var c = countAiMessages();
        var t = getLastAiText();
        if (c > baseAiCount && isRealAiReply(t, baseAiText)) {
          return finish({ type: 'ai_reply', text: t });
        }
        // 通道3: 编辑器空 + AI 回复 (消息已被接受)
        if (isEditorEmpty() && c > baseAiCount && isRealAiReply(t, baseAiText)) {
          return finish({ type: 'ai_reply_editor_empty', text: t });
        }
        // 通道1: 弹窗消失
        if (!findBillingPopup()) {
          return finish({ type: 'popup_gone' });
        }
        setTimeout(tick, 300);
      })();
    });
  }

  // ── 核心重试循环 v1.0.2 ──────────────────────────────
  async function loopForToolbar(toolbar) {
    var s = getState(toolbar);
    log("loop v1.0.2 start @ tb='" + toolbarSignature(toolbar).slice(0, 40) + "'");

    var baseAiCount = countAiMessages();
    var baseAiText = getLastAiText();

    // 第一次提交 (用户已在编辑器输入, 点击卡吧司机按钮)
    s.count = 1; updateAllUI();
    clickSubmit(toolbar);

    // 等待: 弹窗出现(被拒) 或 AI 回复(成功)
    var firstCheck = await Promise.race([
      waitForBilling(CFG.SEND_TIMEOUT_MS).then(function(f) { return f ? 'billing' : 'no_billing'; }),
      waitForNewAi(baseAiCount, baseAiText, CFG.SEND_TIMEOUT_MS).then(function(r) { return r ? ('ai:' + r) : 'no_ai'; })
    ]);

    if (typeof firstCheck === 'string' && firstCheck.indexOf('ai:') === 0) {
      log("首次提交即成功");
      await waitAiStable(firstCheck.slice(3), 90000);
      playVictorySound();
      stopForToolbar(toolbar);
      return;
    }
    if (firstCheck === 'no_billing' || firstCheck === 'no_ai') {
      // 无弹窗也无AI回复 → 再检查一次AI状态确认
      var lateCheck = await waitForNewAi(baseAiCount, baseAiText, 3000);
      if (lateCheck) {
        log("延迟确认成功");
        await waitAiStable(lateCheck, 90000);
        playVictorySound();
        stopForToolbar(toolbar);
        return;
      }
      if (firstCheck === 'no_billing' && !findBillingPopup()) {
        log("无弹窗 视为成功");
        playVictorySound();
        stopForToolbar(toolbar);
        return;
      }
      // 有弹窗但 no_ai → 继续进入重试循环
    }

    // 被拒 → 进入快速重试循环 (通过 sticky bubble 重发, 不创建新对话)
    while (s.active && s.count < CFG.MAX_RETRIES) {
      s.count++;
      updateAllUI();

      // 通过 sticky bubble 重发 (trusted button click, 同一对话)
      await sleep(300);
      var sent = await sendTopForToolbar(toolbar);
      if (!sent) {
        log("第" + s.count + "轮: 发送失败, 重试");
        continue;
      }
      log("第" + s.count + "轮: 已重发");

      // 双通道检测: 弹窗消失 或 AI 回复
      var result = await raceDetect(baseAiCount, baseAiText, 8000);

      if (result.type === 'ai_reply' || result.type === 'ai_reply_editor_empty') {
        log("成功! 第" + s.count + "轮 (" + result.type + "), AI 回复: " + result.text.slice(0, 50));
        await waitAiStable(result.text, 90000);
        playVictorySound();
        stopForToolbar(toolbar);
        return;
      }

      if (result.type === 'popup_gone') {
        // 弹窗消失 → 可能成功, 再等 3s 确认 AI 回复
        var confirm = await waitForNewAi(baseAiCount, baseAiText, 3000);
        if (confirm) {
          log("成功! 第" + s.count + "轮 (弹窗消失+AI确认)");
          await waitAiStable(confirm, 90000);
          playVictorySound();
          stopForToolbar(toolbar);
          return;
        }
        // 弹窗消失但无 AI 回复 → 等弹窗重新出现再继续
        var again = await waitForBillingStableReappear(CFG.REAPPEAR_TIMEOUT_MS, CFG.STABLE_VISIBLE_MS);
        if (!again) {
          log("弹窗未重现, 视为成功");
          playVictorySound();
          stopForToolbar(toolbar);
          return;
        }
      }

      // timeout → 继续下一轮
    }
    log("达到最大重试次数: " + CFG.MAX_RETRIES);
    stopForToolbar(toolbar);
  }
  function startForToolbar(toolbar) {
    var s = getState(toolbar);
    if (s.active) { stopForToolbar(toolbar); return null; }
    s.active = true; s.count = 0;
    updateAllUI();
    s.loopHandle = loopForToolbar(toolbar);
    return s.loopHandle;
  }
  function stopForToolbar(toolbar) {
    var s = getState(toolbar);
    s.active = false; s.count = 0; s.loopHandle = null;
    updateAllUI();
  }
  function toggleGuardForToolbar(toolbar) {
    var s = getState(toolbar);
    s.guarding = !s.guarding;
    persistGuard(toolbar);
    log("guard " + (s.guarding ? "ON" : "OFF") + " @ tb='" + toolbarSignature(toolbar).slice(0, 40) + "'");
    updateAllUI();
  }

  // ── 注入按钮 ───────────────────────────────────────────
  function injectIntoToolbar(toolbar) {
    if (!toolbar) return false;
    if (toolbar.querySelector("." + BTN_CLASS)) return true;
    var submit = findToolbarSubmit(toolbar);
    if (!submit) return false;
    var modelTrigger = findToolbarModelTrigger(toolbar);
    ensureCss();

    var mainBtn = document.createElement("button");
    mainBtn.type = "button";
    mainBtn.className = BTN_CLASS;
    mainBtn.title = BTN_LABEL + " · 点击启动/停止自动重试";
    mainBtn.setAttribute("aria-label", mainBtn.title);
    Object.assign(mainBtn.style, {
      marginLeft: "4px", marginRight: "0px",
      height: "28px",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      gap: "5px",
      paddingLeft: "9px", paddingRight: "11px",
      borderRadius: "9999px",
      cursor: "pointer", flexShrink: "0",
      userSelect: "none", position: "relative",
      border: "1px solid rgba(249,115,22,0.45)",
      background: "transparent",
      color: BRAND_COLOR,
      fontSize: "12px", lineHeight: "1",
      fontWeight: "600", letterSpacing: "0.5px",
      transition: "background 0.15s, color 0.15s, transform 0.1s",
      zIndex: "10", isolation: "isolate",
      whiteSpace: "nowrap",
    });
    mainBtn.appendChild(createIconSvg());
    var label = document.createElement("span");
    label.className = "kaba-retry-v9-label";
    label.textContent = BTN_LABEL;
    mainBtn.appendChild(label);
    mainBtn.addEventListener("mouseenter", function () {
      var s = getState(toolbar);
      if (!s.active) mainBtn.style.background = BRAND_BG_HOVER;
    });
    mainBtn.addEventListener("mouseleave", function () {
      var s = getState(toolbar);
      if (!s.active) mainBtn.style.background = "transparent";
    });
    mainBtn.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      startForToolbar(toolbar);
    }, true);

    var guardBtn = document.createElement("button");
    guardBtn.type = "button";
    guardBtn.className = GUARD_CLASS;
    guardBtn.title = "驻留监测 · 弹账单弹窗时自动启动";
    guardBtn.setAttribute("aria-label", guardBtn.title);
    Object.assign(guardBtn.style, {
      marginLeft: "4px", marginRight: "4px",
      width: "26px", height: "26px",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      borderRadius: "9999px",
      cursor: "pointer", flexShrink: "0",
      userSelect: "none", position: "relative",
      border: "1px solid rgba(249,115,22,0.35)",
      background: "transparent",
      color: "rgba(249,115,22,0.55)",
      transition: "background 0.15s, color 0.15s",
      zIndex: "10",
    });
    guardBtn.appendChild(createEyeSvg());
    guardBtn.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      toggleGuardForToolbar(toolbar);
    }, true);

    /* 插入：modelTrigger 之后、submit 之前 */
    var inserted = false;
    if (modelTrigger && modelTrigger.parentElement === submit.parentElement) {
      submit.parentElement.insertBefore(mainBtn, submit);
      submit.parentElement.insertBefore(guardBtn, submit);
      inserted = true;
    } else if (submit.parentElement) {
      submit.parentElement.insertBefore(mainBtn, submit);
      submit.parentElement.insertBefore(guardBtn, submit);
      inserted = true;
    }
    if (!inserted) return false;

    /* 让状态初始化（含从 sessionStorage 取 guarding） */
    getState(toolbar);
    updateUIForToolbar(toolbar);
    return true;
  }

  function updateUIForToolbar(toolbar) {
    if (!toolbar) return;
    var mainBtn = toolbar.querySelector("." + BTN_CLASS);
    var guardBtn = toolbar.querySelector("." + GUARD_CLASS);
    var s = getState(toolbar);
    if (mainBtn) {
      var svg = mainBtn.querySelector("svg");
      var label = mainBtn.querySelector(".kaba-retry-v9-label");
      var badge = mainBtn.querySelector(".kaba-retry-v9-badge");
      if (s.active) {
        if (svg) svg.style.animation = "kaba-retry-v9-spin 1s linear infinite";
        mainBtn.style.background = BRAND_BG_ACTIVE;
        mainBtn.style.color = "#FFFFFF";
        mainBtn.style.borderColor = BRAND_COLOR;
        if (label) label.textContent = BTN_LABEL + " #" + s.count;
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "kaba-retry-v9-badge";
          Object.assign(badge.style, {
            position: "absolute", top: "-4px", right: "-4px",
            minWidth: "14px", height: "14px", lineHeight: "14px",
            borderRadius: "7px", background: "#c0392b", color: "#fff",
            fontSize: "9px", fontWeight: "700", textAlign: "center",
            padding: "0 3px", pointerEvents: "none", zIndex: "11",
          });
          mainBtn.appendChild(badge);
        }
        badge.textContent = String(s.count);
        badge.style.display = "";
        mainBtn.title = BTN_LABEL + " · 点击停止 (第 " + s.count + " 次)";
      } else {
        if (svg) svg.style.animation = "";
        mainBtn.style.background = "transparent";
        mainBtn.style.color = BRAND_COLOR;
        mainBtn.style.borderColor = "rgba(249,115,22,0.45)";
        if (label) label.textContent = BTN_LABEL;
        if (badge) badge.style.display = "none";
        mainBtn.title = BTN_LABEL + " · 点击启动/停止自动重试";
      }
      mainBtn.setAttribute("aria-label", mainBtn.title);
    }
    if (guardBtn) {
      var gSvg = guardBtn.querySelector("svg");
      if (s.guarding) {
        guardBtn.style.background = BRAND_BG_ACTIVE;
        guardBtn.style.color = "#FFFFFF";
        guardBtn.style.borderColor = BRAND_COLOR;
        if (gSvg) gSvg.style.animation = "kaba-retry-v9-pulse 1.6s ease-in-out infinite";
        guardBtn.title = "驻留监测 · 已开启 · 点击关闭";
      } else {
        guardBtn.style.background = "transparent";
        guardBtn.style.color = "rgba(249,115,22,0.55)";
        guardBtn.style.borderColor = "rgba(249,115,22,0.35)";
        if (gSvg) gSvg.style.animation = "";
        guardBtn.title = "驻留监测 · 已关闭 · 点击开启（弹账单时自动重试）";
      }
      guardBtn.setAttribute("aria-label", guardBtn.title);
    }
  }
  function updateAllUI() {
    listToolbars().forEach(updateUIForToolbar);
  }

  function injectAll() {
    listToolbars().forEach(injectIntoToolbar);
  }

  // ── 全局驻留监测 ────────────────────────────────────────
  var lastGuardTrigger = 0;
  function evaluateGuard() {
    var popup = findBillingPopup();
    if (!popup) return;
    var now = Date.now();
    if (now - lastGuardTrigger < CFG.GUARD_TRIGGER_DEBOUNCE_MS) return;
    /* 找一个可见且 guarding 且非 active 的 toolbar */
    var toolbars = listToolbars();
    /* 当前可见的优先 */
    var ordered = toolbars.slice().sort(function (a, b) {
      return (isVisible(b) ? 1 : 0) - (isVisible(a) ? 1 : 0);
    });
    for (var i = 0; i < ordered.length; i++) {
      var t = ordered[i];
      var s = getState(t);
      if (s.guarding && !s.active) {
        lastGuardTrigger = now;
        log("驻留触发 @ tb='" + toolbarSignature(t).slice(0, 40) + "'");
        startForToolbar(t);
        return;
      }
    }
  }

  // ── DOM observer：注入/驻留 ─────────────────────────────
  var observer = new MutationObserver(function () {
    try {
      if (typeof document === "undefined" || !document.body) return;
      injectAll();
      evaluateGuard();
    } catch (_) {}
  });
  observer.observe(document.body, { childList: true, subtree: true });

  injectAll();

  // ── 全局 API ───────────────────────────────────────────
  window.__kabaRetryV9 = {
    listToolbars: listToolbars,
    getState: function (toolbar) { return toolbar ? getState(toolbar) : null; },
    start: startForToolbar,
    stop: stopForToolbar,
    toggleGuard: toggleGuardForToolbar,
    activeToolbar: function () {
      var tbs = listToolbars();
      for (var i = 0; i < tbs.length; i++) if (isVisible(tbs[i])) return tbs[i];
      return tbs[0] || null;
    },
    label: function () { return BTN_LABEL; },
    diagnose: function () {
      var tbs = listToolbars();
      return {
        toolbarCount: tbs.length,
        toolbars: tbs.map(function (t) {
          var s = getState(t);
          return {
            visible: isVisible(t),
            sig: toolbarSignature(t).slice(0, 60),
            active: s.active, count: s.count, guarding: s.guarding,
            hasMainBtn: !!t.querySelector("." + BTN_CLASS),
            hasGuardBtn: !!t.querySelector("." + GUARD_CLASS),
          };
        }),
        billingPopup: !!findBillingPopup(),
      };
    },
  };

  /* 向后兼容 v8 API：指向当前激活 toolbar */
  function pickActive() { return window.__kabaRetryV9.activeToolbar(); }
  window.__kabaRetryV8 = {
    inject: injectAll,
    start: function () { var t = pickActive(); return t ? startForToolbar(t) : null; },
    stop: function () { var t = pickActive(); if (t) stopForToolbar(t); },
    isActive: function () { var t = pickActive(); return t ? getState(t).active : false; },
    count: function () { var t = pickActive(); return t ? getState(t).count : 0; },
    label: function () { return BTN_LABEL; },
    diagnose: function () { return window.__kabaRetryV9.diagnose(); },
  };

  window.__kabaRetryV9Cleanup = function () {
    listToolbars().forEach(function (t) {
      var s = getState(t);
      s.active = false; s.guarding = false;
    });
    if (observer) { observer.disconnect(); observer = null; }
    Array.prototype.forEach.call(document.querySelectorAll("." + BTN_CLASS + ", ." + GUARD_CLASS), function (el) { el.remove(); });
    window.__kabaRetryV9 = null;
    window.__kabaRetryV8 = null;
  };
  window.__kabaRetryV8Cleanup = window.__kabaRetryV9Cleanup;

  log("v1.0.2 loaded · 三通道检测 · 录音防护 · 付费提示过滤 · 驻留监测");
})();
