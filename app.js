(() => {
  const PUBLIC_WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
  const ACCOUNT_WS_BASE = "wss://api.derivws.com/trading/v1/options/ws";
  const DERIV_CLIENT_ID = "34XuNXjevZ1sJCbMvkPgY";
  const DERIV_REDIRECT_URI = "https://apex-tradershub.netlify.app/";
  const DERIV_AUTH_URL = "https://auth.deriv.com/oauth2/auth";
  const OAUTH_VERIFIER_KEY = "apex_deriv_pkce_verifier";
  const OAUTH_STATE_KEY = "apex_deriv_oauth_state";
  const CONTRACT_NAMES = {
    CALL: "Rise",
    PUT: "Fall",
    HIGHER: "Over",
    LOWER: "Under",
    DIGITDIFF: "Differs",
    DIGITMATCH: "Matches",
    DIGITOVER: "Over",
    DIGITUNDER: "Under",
    DIGITEVEN: "Even",
    DIGITODD: "Odd",
    UPORDOWN: "Rise/Fall",
    EXPIRYRANGE: "Ends Between",
    EXPIRYRANGEE: "Ends Outside",
    ONETOUCH: "Touches",
    NOTOUCH: "Does Not Touch",
    RANGE: "Stays Between",
    CALLE: "Ends Higher",
    PUTE: "Ends Lower",
    ASIANU: "Asian Up",
    ASIAND: "Asian Down",
    MULTUP: "Multiplier Up",
    MULTDOWN: "Multiplier Down",
    RESETCALL: "Reset Call",
    RESETPUT: "Reset Put",
    RUNHIGH: "Only Ups",
    RUNLOW: "Only Downs",
    TICKHIGH: "High Tick",
    TICKLOW: "Low Tick",
    ACCU: "Accumulator",
    VANILLALONGCALL: "Vanilla Call",
    VANILLALONGPUT: "Vanilla Put",
    TURBOSLONG: "Turbos Long",
    TURBOSSHORT: "Turbos Short",
    EXPIRYMISS: "Ends Outside",
    EXPIRYMISSE: "Ends Between"
  };
  const DIGIT_CONTRACTS = new Set(["DIGITDIFF", "DIGITMATCH", "DIGITOVER", "DIGITUNDER"]);
  const REQUIRED_BARRIERS = new Set([
    "DIGITDIFF", "DIGITMATCH", "DIGITOVER", "DIGITUNDER",
    "HIGHER", "LOWER", "ONETOUCH", "NOTOUCH", "RANGE",
    "EXPIRYRANGE", "EXPIRYRANGEE", "EXPIRYMISS", "EXPIRYMISSE", "UPORDOWN",
    "RUNHIGH", "RUNLOW", "RESETCALL", "RESETPUT",
    "TURBOSLONG", "TURBOSSHORT", "VANILLALONGCALL", "VANILLALONGPUT"
  ]);
  const TWO_BARRIER_CONTRACTS = new Set(["RANGE", "EXPIRYRANGE", "EXPIRYRANGEE", "EXPIRYMISS", "EXPIRYMISSE", "UPORDOWN"]);
  const CHART_RANGES = {
    "1H": { granularity: 60, count: 60 },
    "4H": { granularity: 300, count: 48 },
    "1D": { granularity: 1800, count: 48 },
    "1W": { granularity: 14400, count: 42 },
    "1M": { granularity: 86400, count: 30 }
  };
  const BOT_SAMPLE_SIZE = 200;
  const BOT_MIN_SAMPLES = 100;
  const BOT_MAX_TRADES = 500;
  const BOT_BLOCK_ORDER = ["start", "market", "condition", "trade", "risk"];
  const BOT_BLOCK_INFO = {
    start: { label: "Start bot", icon: "▶" },
    market: { label: "Scan open Volatility markets", icon: "⌕" },
    condition: { label: "If chosen digit frequency is at least", icon: "◉" },
    trade: { label: "Buy chosen Even / Odd contract", icon: "↗" },
    risk: { label: "Stop at session limits", icon: "⛨" }
  };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const money = (amount, currency = "USD") => new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
  const state = {
    publicSocket: null,
    accountSocket: null,
    accountType: null,
    accountAuthorized: null,
    accountBalance: null,
    oauthAuthenticated: false,
    oauthAccounts: [],
    portfolioContracts: new Map(),
    openContractsSubscribed: false,
    activeSymbols: [],
    selectedSymbol: "",
    selectedContract: null,
    contracts: [],
    contractGroups: new Map(),
    tickHistory: new Map(),
    botDigitHistory: new Map(),
    chartHistory: new Map(),
    tickSubscriptions: new Map(),
    tickPending: new Set(),
    requestSequence: 0,
    pending: new WeakMap(),
    reconnectTimer: null,
    accountTimer: null,
    selectedTimeframe: "1M",
    proposalBusy: false,
    orderUncertain: false,
    bot: {
      running: false,
      starting: false,
      scanning: false,
      busy: false,
      activeContractId: null,
      contractSubscriptionId: null,
      timer: null,
      summaryTimer: null,
      scanSequence: 0,
      candidates: [],
      contracts: new Map(),
      monitorSymbol: "",
      marketOptionsSignature: "",
      flowSignature: "",
      tickSequence: 0,
      builderBlocks: ["start", "market", "condition", "trade", "risk"],
      zoom: 100,
      draggingBlock: "",
      lastActivity: "",
      realized: 0,
      trades: 0,
      wins: 0,
      losses: 0,
      currency: "USD"
    }
  };

  const toast = $("#toast");
  let toastTimer;

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3200);
  }

  function setFeedStatus(message, status) {
    const element = $("#feed-status");
    element.className = `market-status feed-${status}`;
    element.innerHTML = `<span class="status-dot"></span>${message}`;
  }

  function pendingRequests(socket) {
    let requests = state.pending.get(socket);
    if (!requests) {
      requests = new Map();
      state.pending.set(socket, requests);
    }
    return requests;
  }

  function sendRequest(socket, request, timeout = 12000) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Deriv connection is not open."));
    }
    const reqId = ++state.requestSequence;
    const payload = { ...request, req_id: reqId };
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingRequests(socket).delete(reqId);
        reject(new Error("Deriv did not respond in time. Please try again."));
      }, timeout);
      pendingRequests(socket).set(reqId, {
        resolve: (message) => {
          window.clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        }
      });
      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        window.clearTimeout(timer);
        pendingRequests(socket).delete(reqId);
        reject(error);
      }
    });
  }

  function receiveMessage(socket, message) {
    const reqId = message.req_id ?? message.echo_req?.req_id;
    const requests = pendingRequests(socket);
    const pending = requests.get(reqId);
    if (!pending) return;
    requests.delete(reqId);
    if (message.error) {
      const error = new Error(message.error.message || "Deriv request failed.");
      error.apiCode = message.error.code;
      pending.reject(error);
      return;
    }
    pending.resolve(message);
  }

  function formatPrice(quote, pipSize) {
    const decimals = Number.isInteger(pipSize) ? 0 : Math.max(0, Math.min(10, String(pipSize).split(".")[1]?.length || 2));
    return new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(quote);
  }

  function proposalPayout(proposal, currency) {
    const payout = Number(proposal?.payout);
    return Number.isFinite(payout) && payout > 0 ? money(payout, currency) : "Variable";
  }

  function isDerived(symbol) {
    const market = `${symbol.market || ""} ${symbol.submarket || ""} ${symbol.subgroup || ""} ${symbol.underlying_symbol_type || ""}`.toLowerCase();
    return /synthetic|derived|random_index|crash|boom|volatility|jump|step|drift|range_break|daily_reset/.test(market);
  }

  function marketGroup(symbol) {
    if (isDerived(symbol)) return "Derived indices";
    const market = (symbol.market || "").toLowerCase();
    if (market.includes("forex")) return "Forex";
    if (market.includes("commodit") || market.includes("metals")) return "Commodities";
    if (market.includes("stock") || market.includes("equities")) return "Stocks";
    if (market.includes("crypto")) return "Cryptocurrencies";
    return "Other markets";
  }

  function symbolTone(symbol) {
    const text = `${symbol.market || ""} ${symbol.submarket || ""} ${symbol.underlying_symbol_name || ""}`.toLowerCase();
    if (isDerived(symbol)) return "orange-symbol";
    if (text.includes("forex")) return "blue-symbol";
    if (text.includes("commod") || text.includes("metal")) return "gold-symbol";
    return "purple-symbol";
  }

  function shortName(symbol) {
    const name = symbol.underlying_symbol_name || symbol.underlying_symbol;
    if (/volatility/i.test(name)) return name.replace(/^Volatility\s*/i, "Volatility ");
    return name;
  }

  function isVolatilityMarket(symbol) {
    return /volatility/i.test(symbol?.underlying_symbol_name || "");
  }

  function tickDigit(quote, symbol) {
    const value = Number(quote);
    if (!Number.isFinite(value)) return null;
    const pipSize = Number(symbol?.pip_size);
    const decimals = Number.isInteger(pipSize) && pipSize >= 0 && pipSize <= 10
      ? pipSize
      : Math.max(0, String(quote).split(".")[1]?.length || 0);
    const digits = value.toFixed(decimals).replace(/\D/g, "");
    return digits.length ? Number(digits[digits.length - 1]) : null;
  }

  function volatilitySymbols() {
    return state.activeSymbols.filter((symbol) =>
      isVolatilityMarket(symbol) && symbol.exchange_is_open && !symbol.is_trading_suspended
    );
  }

  function setBotActivity(message) {
    $("#bot-activity").textContent = message;
    if (state.bot.lastActivity === message) return;
    state.bot.lastActivity = message;
    const journal = $("#bot-journal");
    journal.querySelector(".builder-output-empty")?.remove();
    const entry = document.createElement("div");
    entry.className = "bot-journal-entry";
    const time = document.createElement("time");
    time.dateTime = new Date().toISOString();
    time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const text = document.createElement("span");
    text.textContent = message;
    entry.append(time, text);
    journal.prepend(entry);
    while (journal.children.length > 60) journal.lastElementChild.remove();
  }

  function addBotTransaction(contract, status, profit) {
    const list = $("#bot-transactions");
    list.querySelector(".builder-output-empty")?.remove();
    const contractId = String(contract.contract_id || "");
    let row = Array.from(list.children).find((element) => element.dataset.contractId === contractId);
    if (!row) {
      row = document.createElement("div");
      row.className = "bot-transaction-row";
      row.dataset.contractId = contractId;
      const details = document.createElement("div");
      details.className = "bot-transaction-details";
      const market = document.createElement("strong");
      market.textContent = `${shortName({ underlying_symbol_name: contract.underlying || contract.symbol, underlying_symbol: contract.underlying || contract.symbol })} · ${formatContractName(contract.contract_type || "")}`;
      const metadata = document.createElement("small");
      metadata.textContent = `#${contractId} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      details.append(market, metadata);
      const stake = document.createElement("span");
      stake.className = "bot-transaction-stake";
      stake.textContent = money(Number(contract.buy_price) || 0, state.bot.currency);
      const result = document.createElement("strong");
      result.className = "bot-transaction-result";
      row.append(details, stake, result);
      list.prepend(row);
      while (list.children.length > 60) list.lastElementChild.remove();
    }
    const result = $(".bot-transaction-result", row);
    result.textContent = status === "open" ? "Open" : money(profit, state.bot.currency);
    result.classList.toggle("positive", status !== "open" && profit >= 0);
    result.classList.toggle("negative", status !== "open" && profit < 0);
  }

  function builderIsReady() {
    const blocks = state.bot.builderBlocks;
    return BOT_BLOCK_ORDER.every((block, index) => blocks[index] === block);
  }

  function builderBlockDetail(type) {
    const parity = $("#bot-parity").value === "DIGITEVEN" ? "Even" : "Odd";
    const currency = state.accountAuthorized?.currency || state.bot.currency || "USD";
    if (type === "start") return "Run the strategy";
    if (type === "market") return "Rank open Volatility markets";
    if (type === "condition") return `${parity} ≥ ${Number($("#bot-threshold").value) || 0}% · last ${BOT_SAMPLE_SIZE} ticks`;
    if (type === "trade") return `${parity} · 1 tick · ${money(Number($("#bot-stake").value) || 0, currency)}`;
    if (type === "risk") return `+${money(Number($("#bot-target").value) || 0, currency)} / −${money(Number($("#bot-loss-limit").value) || 0, currency)} · ${Number($("#bot-trade-limit").value) || 0} trades`;
    return "";
  }

  function updateBotBuilderValues() {
    const ready = builderIsReady();
    const missing = BOT_BLOCK_ORDER.find((block, index) => state.bot.builderBlocks[index] !== block);
    const status = $("#bot-builder-status");
    status.textContent = ready ? "Strategy ready" : `Add ${BOT_BLOCK_INFO[missing]?.label || "required blocks"}`;
    status.classList.toggle("builder-invalid", !ready);
    $("#builder-block-count").textContent = `${state.bot.builderBlocks.length} block${state.bot.builderBlocks.length === 1 ? "" : "s"}`;
    $$(".builder-tool").forEach((button) => {
      button.disabled = state.bot.running || state.bot.starting || state.bot.scanning;
      const type = button.dataset.builderBlock;
      const included = state.bot.builderBlocks.includes(type);
      $(".builder-add", button).textContent = included ? "✓" : "+";
      button.setAttribute("aria-label", `${included ? "Remove" : "Add"} ${BOT_BLOCK_INFO[type]?.label || "strategy"} block`);
    });
    $$(".strategy-block", $("#bot-builder-stack")).forEach((element) => {
      const type = element.dataset.block;
      element.draggable = type !== "start" && !state.bot.running && !state.bot.starting && !state.bot.scanning;
      const detail = $(".strategy-block-detail", element);
      if (detail) detail.textContent = builderBlockDetail(type);
      const remove = $(".builder-remove", element);
      if (remove) remove.disabled = state.bot.running || state.bot.starting || state.bot.scanning;
    });
  }

  function renderBotBuilder() {
    const stack = $("#bot-builder-stack");
    stack.replaceChildren();
    for (const type of state.bot.builderBlocks) {
      const info = BOT_BLOCK_INFO[type];
      if (!info) continue;
      const block = document.createElement("div");
      block.className = "strategy-block";
      block.dataset.block = type;
      block.draggable = type !== "start" && !state.bot.running && !state.bot.starting && !state.bot.scanning;
      const icon = document.createElement("span");
      icon.textContent = info.icon;
      const label = document.createElement("span");
      label.className = "strategy-block-label";
      label.textContent = info.label;
      const detail = document.createElement("strong");
      detail.className = "strategy-block-detail";
      detail.textContent = builderBlockDetail(type);
      const remove = document.createElement("button");
      remove.className = "builder-remove";
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${info.label} block`);
      remove.addEventListener("click", () => toggleBuilderBlock(type));
      block.append(icon, label, detail, remove);
      block.addEventListener("dragstart", (event) => {
        state.bot.draggingBlock = type;
        block.classList.add("is-dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", type);
      });
      block.addEventListener("dragend", () => {
        state.bot.draggingBlock = "";
        block.classList.remove("is-dragging");
        $$(".strategy-block", stack).forEach((item) => item.classList.remove("drop-before"));
      });
      block.addEventListener("dragover", (event) => {
        if (!state.bot.draggingBlock || state.bot.draggingBlock === type || type === "start") return;
        event.preventDefault();
        block.classList.add("drop-before");
      });
      block.addEventListener("dragleave", () => block.classList.remove("drop-before"));
      block.addEventListener("drop", (event) => {
        event.preventDefault();
        const source = state.bot.draggingBlock || event.dataTransfer.getData("text/plain");
        if (!source || source === type || type === "start") return;
        const blocks = state.bot.builderBlocks.filter((item) => item !== source);
        const targetIndex = blocks.indexOf(type);
        blocks.splice(targetIndex, 0, source);
        state.bot.builderBlocks = blocks;
        renderBotBuilder();
      });
      stack.append(block);
    }
    if (!state.bot.builderBlocks.length) {
      const empty = document.createElement("p");
      empty.className = "builder-empty";
      empty.textContent = "Add strategy blocks from the toolbox to build the Even / Odd bot.";
      stack.append(empty);
    }
    updateBotControls();
  }

  function toggleBuilderBlock(type) {
    if (state.bot.running || state.bot.starting || state.bot.scanning) return;
    if (type === "start") return;
    if (state.bot.builderBlocks.includes(type)) {
      state.bot.builderBlocks = state.bot.builderBlocks.filter((block) => block !== type);
    } else {
      state.bot.builderBlocks = [...state.bot.builderBlocks, type]
        .sort((a, b) => BOT_BLOCK_ORDER.indexOf(a) - BOT_BLOCK_ORDER.indexOf(b));
    }
    renderBotBuilder();
    updateBotControls();
  }

  function renderDigitMonitor(sample, symbol) {
    const grid = $("#bot-digit-grid");
    if (grid.children.length !== 10) {
      grid.replaceChildren();
      for (let digit = 0; digit <= 9; digit += 1) {
        const stat = document.createElement("div");
        stat.className = "digit-stat";
        stat.dataset.digit = String(digit);
        stat.setAttribute("role", "listitem");
        const circle = document.createElement("div");
        circle.className = "digit-circle";
        const number = document.createElement("span");
        number.className = "digit-circle-number";
        number.textContent = String(digit);
        const rate = document.createElement("strong");
        rate.className = "digit-circle-rate";
        rate.textContent = "—";
        circle.append(number, rate);
        const count = document.createElement("span");
        count.className = "digit-stat-count";
        count.textContent = "0 ticks";
        stat.append(circle, count);
        grid.append(stat);
      }
    }

    const counts = Array(10).fill(0);
    for (const item of sample) counts[item.digit] += 1;
    const total = sample.length;
    const latestDigit = sample[sample.length - 1]?.digit;
    const observedCounts = total ? counts : [];
    const highestCount = observedCounts.length ? Math.max(...observedCounts) : -1;
    const lowestCount = observedCounts.length ? Math.min(...observedCounts) : -1;
    for (let digit = 0; digit <= 9; digit += 1) {
      const stat = grid.children[digit];
      const percent = total ? counts[digit] / total * 100 : 0;
      stat.dataset.digitParity = digit % 2 === 0 ? "even" : "odd";
      stat.classList.toggle("is-latest", digit === latestDigit);
      stat.classList.toggle("is-most", highestCount > lowestCount && counts[digit] === highestCount);
      stat.classList.toggle("is-least", highestCount > lowestCount && counts[digit] === lowestCount);
      $(".digit-circle", stat).style.setProperty("--digit-rate", percent.toFixed(2));
      $(".digit-circle-rate", stat).textContent = total ? `${percent.toFixed(1)}%` : "—";
      $(".digit-stat-count", stat).textContent = `${counts[digit]} tick${counts[digit] === 1 ? "" : "s"}`;
      stat.setAttribute("aria-label", total
        ? `Digit ${digit}: ${percent.toFixed(1)} percent, ${counts[digit]} of ${total} ticks`
        : `Digit ${digit}: no tick history`);
    }
    const size = $("#bot-digit-sample-size");
    size.textContent = `${total} tick${total === 1 ? "" : "s"} sampled${symbol ? ` · ${shortName(symbol)}` : ""}`;
    const meta = $("#bot-digit-flow-meta");
    meta.textContent = total ? `${Math.min(total, 32)} recent · latest: ${latestDigit}` : "Waiting for tick history";
    const signature = `${symbol?.underlying_symbol || ""}|${sample.slice(-32).map((item) => `${item.sequence ?? item.epoch}:${item.digit}`).join("|")}`;
    if (signature !== state.bot.flowSignature) {
      state.bot.flowSignature = signature;
      const track = $("#bot-digit-flow-track");
      track.replaceChildren();
      for (const item of sample.slice(-32)) {
        const digit = document.createElement("span");
        digit.className = "digit-flow-item";
        digit.dataset.digitParity = item.digit % 2 === 0 ? "even" : "odd";
        digit.textContent = String(item.digit);
        digit.setAttribute("aria-hidden", "true");
        track.append(digit);
      }
      const latest = track.lastElementChild;
      latest?.classList.add("is-latest");
      requestAnimationFrame(() => {
        const viewport = $("#bot-digit-flow").clientWidth;
        const maxOffset = Math.max(0, track.scrollWidth - viewport);
        const desiredOffset = Math.max(0, track.scrollWidth - viewport / 2);
        track.style.transform = `translateX(-${Math.min(maxOffset, desiredOffset)}px)`;
      });
    }
  }

  function updateBotControls() {
    const status = $("#bot-status");
    const running = state.bot.running;
    const busy = state.bot.scanning || state.bot.starting;
    const feedReady = state.publicSocket?.readyState === WebSocket.OPEN && state.activeSymbols.length > 0;
    updateBotBuilderValues();
    status.classList.toggle("running", running);
    status.classList.toggle("waiting", busy || (running && Boolean(state.bot.activeContractId)));
    status.innerHTML = `<span class="status-dot"></span>${running ? state.bot.activeContractId ? "Trade is open" : "Bot is running" : busy ? "Starting bot" : "Bot is not running"}`;
    $(".bot-run-state").classList.toggle("is-running", running);
    $("#bot-start").disabled = running || busy || Boolean(state.bot.activeContractId) || !feedReady || !builderIsReady();
    $("#bot-scan").disabled = running || busy || !feedReady;
    $("#bot-stop").disabled = !running && !busy;
    $("#builder-reset").disabled = running || busy;
    $("#builder-quick").disabled = running || busy;
    $("#builder-search").disabled = running || busy;
    $("#builder-zoom-in").disabled = state.bot.zoom >= 140;
    $("#builder-zoom-out").disabled = state.bot.zoom <= 70;
    $("#builder-zoom-level").textContent = `${state.bot.zoom}%`;
    $("#bot-builder-stack").style.zoom = `${state.bot.zoom}%`;
    $("#bot-parity").disabled = running || busy;
    $("#bot-stake").disabled = running || busy;
    $("#bot-target").disabled = running || busy;
    $("#bot-loss-limit").disabled = running || busy;
    $("#bot-trade-limit").disabled = running || busy;
    $("#bot-threshold").disabled = running || busy;
  }

  function updateBotSummary() {
    const direction = $("#bot-parity").value;
    const targetDigit = direction === "DIGITEVEN" ? "even" : "odd";
    const rankings = state.bot.candidates.map((symbol) => {
      const history = state.botDigitHistory.get(symbol.underlying_symbol) || [];
      const sample = history.slice(-BOT_SAMPLE_SIZE);
      const hits = sample.filter((entry) => entry.digit % 2 === (targetDigit === "even" ? 0 : 1)).length;
      return { symbol, sample, hits, rate: sample.length ? hits / sample.length : 0 };
    }).filter((item) => item.sample.length >= BOT_MIN_SAMPLES)
      .sort((a, b) => b.rate - a.rate || b.sample.length - a.sample.length);
    const best = rankings[0];
    const marketSelect = $("#bot-digit-market");
    const marketSignature = state.bot.candidates.map((symbol) => symbol.underlying_symbol).join("|");
    if (marketSignature !== state.bot.marketOptionsSignature) {
      state.bot.marketOptionsSignature = marketSignature;
      marketSelect.replaceChildren();
      for (const symbol of state.bot.candidates) {
        marketSelect.add(new Option(`${shortName(symbol)} (${symbol.underlying_symbol})`, symbol.underlying_symbol));
      }
    }
    if (!state.bot.candidates.some((symbol) => symbol.underlying_symbol === marketSelect.value)) {
      state.bot.monitorSymbol = best?.symbol.underlying_symbol || state.bot.candidates[0]?.underlying_symbol || "";
      marketSelect.value = state.bot.monitorSymbol;
    } else {
      state.bot.monitorSymbol = marketSelect.value;
    }
    const monitor = state.bot.candidates.find((symbol) => symbol.underlying_symbol === state.bot.monitorSymbol);
    const digitSample = monitor ? (state.botDigitHistory.get(monitor.underlying_symbol) || []).slice(-BOT_SAMPLE_SIZE) : [];
    renderDigitMonitor(digitSample, monitor);
    if (!best) {
      $("#bot-best-market").textContent = state.bot.candidates.length ? "Collecting live tick history…" : "Scan to load tick history";
      $("#bot-best-rate").textContent = "—";
      $("#bot-sample-count").textContent = "—";
    } else {
      $("#bot-best-market").textContent = `${shortName(best.symbol)} (${best.symbol.underlying_symbol})`;
      $("#bot-best-rate").textContent = `${(best.rate * 100).toFixed(1)}% observed ${targetDigit}`;
      $("#bot-sample-count").textContent = `${best.sample.length} / ${BOT_SAMPLE_SIZE}`;
    }
    const pnl = $("#bot-session-pnl");
    pnl.textContent = money(state.bot.realized, state.bot.currency);
    pnl.classList.toggle("positive", state.bot.realized > 0);
    pnl.classList.toggle("negative", state.bot.realized < 0);
    $("#bot-trade-count").textContent = String(state.bot.trades);
    $("#bot-win-loss").textContent = `${state.bot.wins} / ${state.bot.losses}`;
    updateBotBuilderValues();
    return { best, eligible: rankings.filter((item) => item.rate * 100 >= Number($("#bot-threshold").value)) };
  }

  async function scanBotMarkets() {
    if (state.bot.scanning) return;
    if (!state.activeSymbols.length || state.publicSocket?.readyState !== WebSocket.OPEN) {
      setBotActivity("Waiting for the Deriv live market feed before scanning.");
      return;
    }
    const candidates = volatilitySymbols();
    if (!candidates.length) {
      state.bot.candidates = [];
      updateBotSummary();
      setBotActivity("No open Volatility markets are currently available.");
      return;
    }
    state.bot.candidates = candidates;
    const scanId = ++state.bot.scanSequence;
    state.bot.scanning = true;
    updateBotControls();
    setBotActivity(`Loading recent ticks for ${candidates.length} open Volatility markets…`);
    for (const symbol of candidates) subscribeToTick(symbol.underlying_symbol);

    let nextIndex = 0;
    let loaded = 0;
    const workers = Array.from({ length: Math.min(5, candidates.length) }, async () => {
      while (nextIndex < candidates.length && scanId === state.bot.scanSequence) {
        const index = nextIndex++;
        const symbol = candidates[index];
        try {
          const response = await sendRequest(state.publicSocket, {
            ticks_history: symbol.underlying_symbol,
            end: "latest",
            count: BOT_SAMPLE_SIZE,
            style: "ticks"
          });
          if (scanId !== state.bot.scanSequence) return;
          const prices = response.history?.prices || [];
          const times = response.history?.times || [];
          const historic = prices.map((price, itemIndex) => ({
            digit: tickDigit(price, symbol),
            epoch: Number(times[itemIndex]) || 0,
            sequence: (Number(times[itemIndex]) || 0) * 1000 + itemIndex
          })).filter((item) => item.digit !== null);
          const live = state.botDigitHistory.get(symbol.underlying_symbol) || [];
          const newestHistory = historic[historic.length - 1]?.epoch || 0;
          const merged = [...historic, ...live.filter((item) => item.epoch > newestHistory)]
            .sort((a, b) => a.epoch - b.epoch)
            .slice(-BOT_SAMPLE_SIZE);
          state.botDigitHistory.set(symbol.underlying_symbol, merged);
          loaded += 1;
        } catch {
          if (scanId !== state.bot.scanSequence) return;
          loaded += 1;
        }
        setBotActivity(`Loading tick history… ${loaded} of ${candidates.length} markets checked.`);
      }
    });
    await Promise.all(workers);
    if (scanId !== state.bot.scanSequence) return;
    state.bot.scanning = false;
    const { best } = updateBotSummary();
    updateBotControls();
    setBotActivity(best
      ? `Scan complete. Ranking uses the last ${best.sample.length} ticks per market; it describes past frequency only.`
      : "Scan complete, but there are not yet enough ticks per market. Keep the feed open and scan again.");
  }

  function renderMarketOptions(symbols) {
    const select = $("#market-select");
    select.replaceChildren();
    const groups = new Map();
    for (const symbol of symbols) {
      const groupName = marketGroup(symbol);
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName).push(symbol);
    }
    const order = ["Derived indices", "Forex", "Commodities", "Stocks", "Cryptocurrencies", "Other markets"];
    for (const groupName of order) {
      const members = groups.get(groupName);
      if (!members?.length) continue;
      const group = document.createElement("optgroup");
      group.label = `${groupName}${groupName === "Derived indices" ? ` (${members.length})` : ""}`;
      members.sort((a, b) => shortName(a).localeCompare(shortName(b)));
      for (const symbol of members) {
        const option = document.createElement("option");
        option.value = symbol.underlying_symbol;
        option.textContent = `${shortName(symbol)} · ${groupName}`;
        group.append(option);
      }
      select.append(group);
    }
    const preferred = symbols.find(isDerived) || symbols[0];
    if (preferred) {
      select.value = preferred.underlying_symbol;
      setSelectedSymbol(preferred.underlying_symbol);
    }
    select.disabled = symbols.length === 0;
  }

  function renderMarketWatch() {
    const derived = state.activeSymbols.filter(isDerived);
    const chosen = (derived.length ? derived : state.activeSymbols).slice(0, 4);
    const table = $(".market-table");
    table.replaceChildren();
    const head = document.createElement("div");
    head.className = "market-table-head";
    for (const label of ["Market", "Price", "Tick change", ""]) {
      const cell = document.createElement("span");
      cell.textContent = label;
      head.append(cell);
    }
    table.append(head);
    for (const symbol of chosen) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "market-row";
      row.dataset.market = symbol.underlying_symbol;
      const info = document.createElement("span");
      info.className = "market-info";
      const badge = document.createElement("span");
      badge.className = `mini-symbol ${symbolTone(symbol)}`;
      badge.textContent = symbol.underlying_symbol.length > 4 ? symbol.underlying_symbol.slice(0, 4) : symbol.underlying_symbol;
      const label = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = shortName(symbol);
      const category = document.createElement("small");
      category.textContent = symbol.submarket || symbol.market || "Deriv";
      label.append(name, category);
      info.append(badge, label);
      const price = document.createElement("span");
      price.className = "row-price";
      price.textContent = "Waiting…";
      const change = document.createElement("span");
      change.className = "row-change";
      change.textContent = "—";
      const spark = document.createElement("span");
      spark.className = "sparkline";
      spark.textContent = "⌁";
      row.append(info, price, change, spark);
      row.addEventListener("click", () => {
        $("#market-select").value = symbol.underlying_symbol;
        setSelectedSymbol(symbol.underlying_symbol);
        $("#quick-trade").scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
      table.append(row);
    }
  }

  function showNoContracts(message) {
    const select = $("#contract-select");
    select.replaceChildren(new Option(message, ""));
    select.disabled = true;
    $("#trade-submit").disabled = true;
  }

  function formatContractName(type) {
    return CONTRACT_NAMES[type] || type.replaceAll("_", " ");
  }

  function renderContracts(contracts) {
    const select = $("#contract-select");
    const available = contracts.filter((item) => item.contract_type);
    state.contracts = available;
    state.contractGroups = new Map();
    for (const contract of available) {
      if (!state.contractGroups.has(contract.contract_type)) state.contractGroups.set(contract.contract_type, []);
      state.contractGroups.get(contract.contract_type).push(contract);
    }
    select.replaceChildren();
    if (!state.contractGroups.size) {
      showNoContracts("No contracts offered for this market");
      return;
    }
    for (const contractType of state.contractGroups.keys()) {
      const option = new Option(`${formatContractName(contractType)} (${contractType})`, contractType);
      select.append(option);
    }
    select.disabled = false;
    const preferred = state.contractGroups.has("CALL") ? "CALL"
      : state.contractGroups.has("DIGITEVEN") ? "DIGITEVEN"
        : state.contractGroups.keys().next().value;
    select.value = preferred;
    setSelectedContract(preferred);
  }

  function availableUnits(contract) {
    const expiry = (contract?.expiry_type || "").toLowerCase();
    if (expiry === "no_expiry") return [];
    if (expiry === "tick") return ["t"];
    if (expiry === "daily") return ["d"];
    if (expiry === "intraday") {
      const minUnit = String(contract.min_contract_duration || "").match(/[tsmhd]$/)?.[0];
      return minUnit ? [minUnit] : ["s", "m", "h"];
    }
    const minUnit = String(contract?.min_contract_duration || "").match(/[tsmhd]$/)?.[0];
    return minUnit ? [minUnit] : ["t", "s", "m", "h", "d"];
  }

  function contractForUnit(contractType, unit) {
    const variants = state.contractGroups.get(contractType) || [];
    return variants.find((variant) => availableUnits(variant).includes(unit)) || variants[0] || null;
  }

  function configureDuration(contract, unit) {
    const minMatch = String(contract?.min_contract_duration || "").match(/^(\d+)/);
    const maxMatch = String(contract?.max_contract_duration || "").match(/^(\d+)/);
    const duration = $("#duration-input");
    const min = minMatch ? Number(minMatch[1]) : 1;
    duration.min = String(min > 0 ? min : 1);
    duration.max = maxMatch ? maxMatch[1] : "";
    duration.value = String(min > 0 ? min : unit === "t" ? 5 : 1);
  }

  function setSelectOptions(select, values, placeholder) {
    select.replaceChildren();
    if (placeholder) select.add(new Option(placeholder, ""));
    for (const value of values || []) select.add(new Option(String(value), String(value)));
  }

  function setDurationOptions(contractType) {
    const unitSelect = $("#duration-unit");
    const variants = state.contractGroups.get(contractType) || [];
    const units = [...new Set(variants.flatMap(availableUnits))];
    unitSelect.replaceChildren();
    const names = { t: "ticks", s: "seconds", m: "minutes", h: "hours", d: "days" };
    for (const unit of units) unitSelect.add(new Option(names[unit], unit));
    const preferredUnit = units.includes("t") ? "t" : units[0] || "";
    unitSelect.value = preferredUnit;
    state.selectedContract = contractForUnit(contractType, preferredUnit);
    configureDuration(state.selectedContract, preferredUnit);
    const isTimed = state.selectedContract?.expiry_type !== "no_expiry";
    $("#duration-label").hidden = !isTimed;
    $("#duration-row").hidden = !isTimed;
    $("#duration-input").required = isTimed;
  }

  function updateContractFields(contractType, contract) {
    const needsBarrier = DIGIT_CONTRACTS.has(contractType) || (contractType !== "ACCU" && Number(contract?.barriers) > 0);
    const needsSecondBarrier = TWO_BARRIER_CONTRACTS.has(contractType) && Number(contract?.barriers) > 1;
    const digitContract = DIGIT_CONTRACTS.has(contractType);
    $("#barrier-label").hidden = !needsBarrier;
    $("#barrier-input").hidden = !needsBarrier;
    $("#barrier-input").required = REQUIRED_BARRIERS.has(contractType);
    $("#barrier-input").type = digitContract ? "number" : "text";
    $("#barrier-input").min = digitContract ? "0" : "";
    $("#barrier-input").max = digitContract ? "9" : "";
    $("#barrier-label").textContent = digitContract ? "Last digit (0–9)" : needsSecondBarrier ? "Lower barrier" : REQUIRED_BARRIERS.has(contractType) ? "Barrier" : "Barrier (optional)";
    $("#barrier-input").value = digitContract ? "5" : REQUIRED_BARRIERS.has(contractType) ? contract?.barrier || contract?.low_barrier || "" : "";
    $("#barrier-input").placeholder = digitContract ? "0–9" : contract?.barrier || contract?.low_barrier || "";
    $("#barrier2-label").hidden = !needsSecondBarrier;
    $("#barrier2-input").hidden = !needsSecondBarrier;
    $("#barrier2-input").required = needsSecondBarrier && REQUIRED_BARRIERS.has(contractType);
    $("#barrier2-label").textContent = "Upper barrier";
    $("#barrier2-input").value = contract?.high_barrier || "";
    $("#multiplier-label").hidden = !["MULTUP", "MULTDOWN"].includes(contractType);
    $("#multiplier-input").hidden = !["MULTUP", "MULTDOWN"].includes(contractType);
    $("#multiplier-input").required = ["MULTUP", "MULTDOWN"].includes(contractType);
    setSelectOptions($("#multiplier-input"), contract?.multiplier_range || [1]);
    $("#multiplier-input").value = String(contract?.multiplier_range?.[0] ?? 1);
    $("#cancellation-label").hidden = !["MULTUP", "MULTDOWN"].includes(contractType) || !contract?.cancellation_range?.length;
    $("#cancellation-input").hidden = $("#cancellation-label").hidden;
    setSelectOptions($("#cancellation-input"), contract?.cancellation_range || [], "No cancellation");
    $("#growth-rate-label").hidden = contractType !== "ACCU";
    $("#growth-rate-input").hidden = contractType !== "ACCU";
    $("#growth-rate-input").required = contractType === "ACCU";
    setSelectOptions($("#growth-rate-input"), contract?.growth_rate_range || [0.01]);
    $("#growth-rate-input").value = String(contract?.growth_rate_range?.[0] ?? 0.01);
    $("#selected-tick-label").hidden = !["TICKHIGH", "TICKLOW"].includes(contractType);
    $("#selected-tick-input").hidden = !["TICKHIGH", "TICKLOW"].includes(contractType);
    $("#selected-tick-input").required = ["TICKHIGH", "TICKLOW"].includes(contractType);
    const stake = $("#stake-input");
    stake.min = String(contract?.min_stake || 0.01);
    stake.max = contract?.max_stake == null ? "" : String(contract.max_stake);
    if (Number(contract?.default_stake) > 0) stake.value = String(contract.default_stake);
    $("#currency-code").textContent = state.accountAuthorized?.currency || "USD";
  }

  function setSelectedContract(contractType) {
    setDurationOptions(contractType);
    updateContractFields(contractType, state.selectedContract);
    const label = formatContractName(contractType || "Contract");
    $("#trade-submit strong").textContent = `Review ${label} trade`;
    $("#potential-payout").textContent = state.accountAuthorized ? "Request a fresh proposal" : "Connect to request quote";
    updateTradeAvailability();
  }

  function updateTradeAvailability() {
    const connected = state.accountSocket?.readyState === WebSocket.OPEN && state.accountAuthorized;
    const symbol = state.activeSymbols.find((item) => item.underlying_symbol === state.selectedSymbol);
    const tradeable = Boolean(symbol?.exchange_is_open) && !Boolean(symbol?.is_trading_suspended);
    $("#trade-submit").disabled = !connected || !Number.isFinite(state.accountBalance) || !state.selectedContract || !tradeable || state.proposalBusy || state.orderUncertain || state.bot.running || state.bot.starting || Boolean(state.bot.activeContractId);
    if (!connected) {
      $("#potential-payout").textContent = "Connect to request quote";
      return;
    }
    if ($("#potential-payout").textContent === "Connect to request quote") {
      $("#potential-payout").textContent = "Request a fresh proposal";
    }
  }

  function setSelectedSymbol(code) {
    if (!code) return;
    const previousSymbol = state.selectedSymbol;
    const previousSubscription = state.tickSubscriptions.get(previousSymbol);
    if (previousSubscription && state.publicSocket?.readyState === WebSocket.OPEN) {
      sendRequest(state.publicSocket, { forget: previousSubscription }).catch(() => {});
      state.tickSubscriptions.delete(previousSymbol);
    }
    state.selectedSymbol = code;
    const symbol = state.activeSymbols.find((item) => item.underlying_symbol === code);
    if (!symbol) return;
    $("#chart-symbol").textContent = code.length > 4 ? code.slice(0, 4) : code;
    $("#chart-market").textContent = shortName(symbol);
    $("#chart-category").textContent = symbol.submarket || symbol.market || "Deriv";
    const canTrade = Boolean(symbol.exchange_is_open) && !Boolean(symbol.is_trading_suspended);
    $("#symbol-market-status").classList.toggle("market-closed", !canTrade);
    $("#symbol-market-status-label").textContent = symbol.is_trading_suspended ? "Suspended" : canTrade ? "Open" : "Closed";
    $("#chart-price").textContent = "Waiting…";
    $("#chart-change").textContent = "—";
    $("#chart-change").classList.remove("positive", "negative");
    $("#quote-label").textContent = "Waiting for live ticks";
    $("#tick-updated").textContent = "Waiting for live ticks";
    $("#chart-line").setAttribute("d", "");
    $("#chart-area").setAttribute("d", "");
    $("#chart-point").hidden = true;
    $("#chart-price-tag").hidden = true;
    $("#potential-payout").textContent = state.accountAuthorized ? "Request a fresh proposal" : "Connect to request quote";
    const history = state.tickHistory.get(code);
    if (history?.length) updateChart(state.chartHistory.get(code) || history, code);
    subscribeToTick(code);
    loadContracts(code);
    loadChartHistory(code, state.selectedTimeframe);
  }

  async function loadChartHistory(symbol, timeframe) {
    if (state.publicSocket?.readyState !== WebSocket.OPEN) return;
    const range = CHART_RANGES[timeframe];
    if (!range) return;
    try {
      const response = await sendRequest(state.publicSocket, {
        ticks_history: symbol,
        end: "latest",
        style: "candles",
        granularity: range.granularity,
        count: range.count
      });
      if (symbol !== state.selectedSymbol || timeframe !== state.selectedTimeframe) return;
      const candles = response.candles || [];
      const chartPoints = candles
        .filter((candle) => Number.isFinite(Number(candle.close)) && Number.isFinite(Number(candle.epoch)))
        .map((candle) => ({ quote: Number(candle.close), epoch: Number(candle.epoch) }));
      if (chartPoints.length) {
        state.chartHistory.set(symbol, chartPoints);
        updateChart(chartPoints, symbol);
      }
    } catch (error) {
      if (symbol === state.selectedSymbol && timeframe === state.selectedTimeframe) showToast(`Chart history unavailable: ${error.message}`);
    }
  }

  async function loadContracts(symbol) {
    showNoContracts("Loading available contracts…");
    try {
      const response = await sendRequest(state.publicSocket, { contracts_for: symbol });
      if (state.selectedSymbol !== symbol) return;
      renderContracts(response.contracts_for?.available || []);
    } catch (error) {
      if (state.selectedSymbol !== symbol) return;
      showNoContracts("Contracts unavailable");
      showToast(error.message);
    }
  }

  function chartCoordinates(prices) {
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    const range = high - low || Math.max(Math.abs(high) * 0.0001, 0.00001);
    const pad = range * 0.14;
    const min = low - pad;
    const max = high + pad;
    return prices.map((price, index) => {
      const x = prices.length === 1 ? 760 : index * 760 / (prices.length - 1);
      const y = 226 - ((price - min) / (max - min)) * 204;
      return { x, y, price };
    });
  }

  function updateChart(chartPoints, symbol) {
    if (symbol !== state.selectedSymbol || !chartPoints.length) return;
    const prices = chartPoints.map((point) => point.quote);
    const points = chartCoordinates(prices);
    const line = points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
    $("#chart-line").setAttribute("d", line);
    $("#chart-area").setAttribute("d", `${line} L760 244 L0 244 Z`);
    const last = points[points.length - 1];
    $("#chart-point").setAttribute("cx", String(last.x));
    $("#chart-point").setAttribute("cy", String(last.y));
    const symbolInfo = state.activeSymbols.find((item) => item.underlying_symbol === symbol);
    const pip = symbolInfo?.pip_size;
    const priceText = formatPrice(last.price, pip);
    $("#chart-point").hidden = false;
    $("#chart-price-tag").hidden = false;
    $("#chart-price").textContent = priceText;
    $("#chart-price-tag").textContent = priceText;
    $("#quote-label").textContent = "Live Deriv quote";
    $(".chart-wrap").setAttribute("aria-label", `Live Deriv price chart for ${shortName(symbolInfo || { underlying_symbol: symbol })}, last price ${priceText}`);
    const axisPrices = [0, 1, 2, 3, 4].map((index) => maxPrice(points) - (maxPrice(points) - minPrice(points)) * index / 4);
    $$(".y-axis span").forEach((label, index) => { label.textContent = formatPrice(axisPrices[index], pip); });
    const ticks = state.tickHistory.get(symbol) || [];
    if (ticks.length > 1) {
      const first = ticks[Math.max(0, ticks.length - 2)].quote;
      const current = ticks[ticks.length - 1].quote;
      const delta = current - first;
      const percent = first ? delta / first * 100 : 0;
      const change = $("#chart-change");
      change.textContent = `${delta >= 0 ? "+" : ""}${formatPrice(delta, pip)} (${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%)`;
      change.classList.toggle("positive", delta >= 0);
      change.classList.toggle("negative", delta < 0);
    }
    const times = chartPoints.filter((tick) => tick.epoch).map((tick) => new Date(tick.epoch * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    if (times.length) {
      const axisLabels = $$(".x-axis span");
      axisLabels.forEach((label, index) => {
        const tickIndex = Math.round(index * (times.length - 1) / Math.max(1, axisLabels.length - 1));
        label.textContent = times[tickIndex];
      });
    }
  }

  function maxPrice(points) {
    return Math.max(...points.map((point) => point.price));
  }

  function minPrice(points) {
    return Math.min(...points.map((point) => point.price));
  }

  function updateWatchRow(symbol, quote, previous) {
    const row = $(`.market-row[data-market="${CSS.escape(symbol)}"]`);
    if (!row) return;
    const info = state.activeSymbols.find((item) => item.underlying_symbol === symbol);
    const price = $(".row-price", row);
    price.textContent = formatPrice(quote, info?.pip_size);
    price.classList.remove("tick-flash");
    void price.offsetWidth;
    price.classList.add("tick-flash");
    if (previous !== undefined) {
      const delta = quote - previous;
      const change = $(".row-change", row);
      change.textContent = `${delta >= 0 ? "+" : ""}${formatPrice(delta, info?.pip_size)}`;
      change.classList.toggle("positive", delta >= 0);
      change.classList.toggle("negative", delta < 0);
      const spark = $(".sparkline", row);
      spark.classList.toggle("up-spark", delta >= 0);
      spark.classList.toggle("down-spark", delta < 0);
    }
  }

  function handleTick(tick) {
    if (!tick?.symbol || !Number.isFinite(Number(tick.quote))) return;
    const code = tick.symbol;
    const quote = Number(tick.quote);
    const symbolInfo = state.activeSymbols.find((item) => item.underlying_symbol === code);
    if (isVolatilityMarket(symbolInfo)) {
      const digit = tickDigit(tick.quote, symbolInfo);
      if (digit !== null) {
        const digits = state.botDigitHistory.get(code) || [];
        digits.push({
          digit,
          epoch: Number(tick.epoch) || Date.now() / 1000,
          sequence: ++state.bot.tickSequence
        });
        if (digits.length > BOT_SAMPLE_SIZE) digits.shift();
        state.botDigitHistory.set(code, digits);
        if (state.bot.candidates.length && !state.bot.scanning) {
          window.clearTimeout(state.bot.summaryTimer);
          state.bot.summaryTimer = window.setTimeout(updateBotSummary, 700);
        }
      }
    }
    const history = state.tickHistory.get(code) || [];
    const previous = history.length ? history[history.length - 1].quote : undefined;
    history.push({ quote, epoch: Number(tick.epoch) || Date.now() / 1000 });
    if (history.length > 100) history.shift();
    state.tickHistory.set(code, history);
    updateWatchRow(code, quote, previous);
    if (code === state.selectedSymbol) {
      const candleHistory = state.chartHistory.get(code) || [];
      const range = CHART_RANGES[state.selectedTimeframe];
      const currentBucket = range ? Math.floor(history[history.length - 1].epoch / range.granularity) * range.granularity : history[history.length - 1].epoch;
      const lastCandle = candleHistory[candleHistory.length - 1];
      if (lastCandle && range && Math.floor(lastCandle.epoch / range.granularity) * range.granularity === currentBucket) {
        lastCandle.quote = quote;
      } else {
        candleHistory.push({ quote, epoch: history[history.length - 1].epoch });
      }
      if (range && candleHistory.length > range.count) candleHistory.splice(0, candleHistory.length - range.count);
      state.chartHistory.set(code, candleHistory);
      updateChart(candleHistory, code);
      $("#tick-updated").textContent = `Tick ${new Date((Number(tick.epoch) || Date.now() / 1000) * 1000).toLocaleTimeString()}`;
    }
  }

  function subscribeToTick(symbol) {
    if (state.publicSocket?.readyState !== WebSocket.OPEN || state.tickSubscriptions.has(symbol) || state.tickPending.has(symbol)) return;
    state.tickPending.add(symbol);
    sendRequest(state.publicSocket, { ticks: symbol, subscribe: 1 }).then((response) => {
      const subscription = response.subscription?.id;
      if (subscription) state.tickSubscriptions.set(symbol, subscription);
      if (response.tick) handleTick(response.tick);
    }).catch((error) => {
      if (symbol === state.selectedSymbol) showToast(`Live quote unavailable: ${error.message}`);
    }).finally(() => {
      state.tickPending.delete(symbol);
    });
  }

  function handlePublicMessage(message) {
    if (message.tick) handleTick(message.tick);
    if (message.msg_type === "active_symbols" && Array.isArray(message.active_symbols)) {
      state.activeSymbols = message.active_symbols;
      renderMarketOptions(state.activeSymbols);
      renderMarketWatch();
      for (const row of $$(".market-row")) subscribeToTick(row.dataset.market);
      state.bot.candidates = volatilitySymbols();
      for (const symbol of state.bot.candidates) subscribeToTick(symbol.underlying_symbol);
      updateBotSummary();
      updateBotControls();
      setFeedStatus("Live Deriv ticks", "live");
    }
  }

  function connectPublicFeed() {
    if (state.publicSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.publicSocket.readyState)) return;
    setFeedStatus("Connecting to Deriv", "loading");
    const socket = new WebSocket(PUBLIC_WS_URL);
    state.publicSocket = socket;
    socket.addEventListener("open", () => {
      if (state.publicSocket !== socket) return;
      sendRequest(socket, { active_symbols: "brief" }).catch((error) => {
        setFeedStatus("Market list unavailable", "error");
        showToast(error.message);
      });
      if (state.selectedSymbol) subscribeToTick(state.selectedSymbol);
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        receiveMessage(socket, message);
        if (message.error && message.msg_type !== "active_symbols") {
          showToast(message.error.message || "Deriv feed error.");
        }
        handlePublicMessage(message);
      } catch {
        setFeedStatus("Invalid feed response", "error");
      }
    });
    socket.addEventListener("error", () => {
      if (state.publicSocket === socket) setFeedStatus("Feed connection error", "error");
    });
    socket.addEventListener("close", () => {
      if (state.publicSocket !== socket) return;
      state.tickSubscriptions.clear();
      state.tickPending.clear();
      if (state.bot.running || state.bot.starting) stopBot("Market data disconnected; bot stopped.");
      updateBotControls();
      setFeedStatus("Feed disconnected · reconnecting", "error");
      state.reconnectTimer = window.setTimeout(connectPublicFeed, 4000);
    });
  }

  function clearPositions(message = "Connect a Deriv account to load positions.") {
    const list = $("#position-list");
    list.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "empty-positions";
    empty.textContent = message;
    list.append(empty);
    $("#position-count").textContent = "0 positions";
  }

  function renderPortfolio(contracts, replace = true) {
    if (replace) state.portfolioContracts = new Map(contracts.map((contract) => [String(contract.contract_id), contract]));
    const portfolio = Array.from(state.portfolioContracts.values());
    const list = $("#position-list");
    list.replaceChildren();
    if (!portfolio.length) {
      clearPositions("No open contracts on this account.");
      return;
    }
    for (const contract of portfolio) {
      const row = document.createElement("div");
      row.className = "position-row";
      const badge = document.createElement("span");
      badge.className = `mini-symbol ${contract.contract_type?.startsWith("DIGIT") ? "purple-symbol" : "blue-symbol"}`;
      badge.textContent = String(contract.underlying || contract.symbol || "DV").slice(0, 4);
      const details = document.createElement("span");
      details.className = "position-info";
      const title = document.createElement("strong");
      title.textContent = contract.longcode || `${contract.underlying || contract.symbol || "Deriv"} ${formatContractName(contract.contract_type || "")}`;
      const meta = document.createElement("small");
      meta.textContent = `${money(Number(contract.buy_price) || 0, state.accountAuthorized?.currency || "USD")} stake · ${contract.contract_id || ""}`;
      details.append(title, meta);
      const result = document.createElement("span");
      result.className = `position-result ${(Number(contract.profit) || 0) >= 0 ? "positive" : "negative"}`;
      result.textContent = money(Number(contract.profit) || 0, state.accountAuthorized?.currency || "USD");
      const status = document.createElement("small");
      status.className = "running-status";
      status.textContent = contract.status || (contract.is_sold ? "Settled" : "Open");
      result.append(status);
      row.append(badge, details, result);
      list.append(row);
    }
    $("#position-count").textContent = `${portfolio.length} position${portfolio.length === 1 ? "" : "s"}`;
  }

  function updateBalance(balance) {
    if (!Number.isFinite(Number(balance.balance))) return;
    state.accountBalance = Number(balance.balance);
    const currency = balance.currency || state.accountAuthorized?.currency || "USD";
    $("#balance-value").textContent = money(Number(balance.balance), currency);
    $("#balance-account-type").textContent = state.accountType === "real" ? "Real funds" : "Demo funds";
    $("#balance-currency").textContent = currency;
    $("#currency-code").textContent = currency;
    $("#currency-symbol").textContent = new Intl.NumberFormat("en-US", { style: "currency", currency }).formatToParts(0).find((part) => part.type === "currency")?.value || currency;
    if (state.accountAuthorized) state.accountAuthorized.currency = currency;
    updateTradeAvailability();
  }

  function handleAccountMessage(socket, message) {
    if (message.msg_type === "authorize" && message.authorize) {
      const authorize = message.authorize;
      const isVirtual = authorize.is_virtual === true || authorize.is_virtual === 1 || authorize.is_virtual === "1";
      if ((state.accountType === "real" && isVirtual) || (state.accountType === "demo" && !isVirtual)) {
        showToast("The connected account type does not match your selection. Disconnecting.");
        socket.close();
        return;
      }
      window.clearTimeout(state.accountTimer);
      state.accountAuthorized = authorize;
      $("#landing-page").hidden = true;
      $("#dashboard-app").hidden = false;
      $("#account-label").textContent = state.accountType === "real" ? "Deriv real account" : "Deriv demo account";
      $("#account-mode-badge").textContent = state.accountType === "real" ? "REAL ACCOUNT" : "DERIV DEMO";
      $("#account-mode-badge").classList.toggle("real-account-badge", state.accountType === "real");
      $("#trade-disclaimer").textContent = state.accountType === "real"
        ? "Real funds at risk. Manual trades require confirmation; the bot trades automatically after its risk confirmation."
        : "Deriv demo account. Orders use demo funds.";
      $("#trade-submit strong").textContent = "Review trade";
      $("#trade-submit small").textContent = state.accountType === "real" ? "Real-money order · confirm before placing" : "Demo order · confirm before placing";
      $("#balance-account-type").textContent = state.accountType === "real" ? "Real funds" : "Demo funds";
      $("#balance-currency").textContent = authorize.currency || "Account connected";
      sendRequest(socket, { balance: 1, subscribe: 1 }).catch((error) => showToast(error.message));
      sendRequest(socket, { portfolio: 1 }).then((response) => renderPortfolio(response.portfolio?.contracts || []))
        .catch((error) => showToast(`Portfolio unavailable: ${error.message}`));
      if (!state.openContractsSubscribed) {
        state.openContractsSubscribed = true;
        sendRequest(socket, { proposal_open_contract: 1, subscribe: 1 }).catch((error) => {
          state.openContractsSubscribed = false;
          showToast(`Live position updates unavailable: ${error.message}`);
        });
      }
      updateTradeAvailability();
      showToast(`Connected to Deriv ${state.accountType} account.`);
      return;
    }
    if (message.msg_type === "balance" && message.balance) updateBalance(message.balance);
    if (message.msg_type === "portfolio") renderPortfolio(message.portfolio?.contracts || []);
    if (message.msg_type === "proposal" && message.proposal) {
      $("#potential-payout").textContent = proposalPayout(message.proposal, state.accountAuthorized?.currency || "USD");
    }
    if (message.msg_type === "buy" && message.buy) {
      const currency = state.accountAuthorized?.currency || "USD";
      if (Number.isFinite(Number(message.buy.balance_after))) updateBalance({ balance: message.buy.balance_after, currency });
      sendRequest(socket, { portfolio: 1 }).then((response) => renderPortfolio(response.portfolio?.contracts || []))
        .catch((error) => showToast(`Order placed, but portfolio refresh failed: ${error.message}`));
      showToast(`Order placed. Contract #${message.buy.contract_id}.`);
    }
    if (message.msg_type === "proposal_open_contract" && message.proposal_open_contract) {
      const contract = message.proposal_open_contract;
      const contractId = String(contract.contract_id || "");
      if (contractId) {
        if (contract.is_sold === true || Number(contract.is_sold) === 1) state.portfolioContracts.delete(contractId);
        else state.portfolioContracts.set(contractId, contract);
        renderPortfolio(Array.from(state.portfolioContracts.values()), false);
        if (contractId === String(state.bot.activeContractId)) {
          if (message.subscription?.id) state.bot.contractSubscriptionId = message.subscription.id;
          handleBotContractUpdate(contract);
        }
      }
    }
    if (message.error && message.error.code === "AuthorizationRequired") {
      state.accountAuthorized = null;
      updateTradeAvailability();
    }
  }

  function disconnectAccount(notify = true) {
    if (state.bot.running || state.bot.starting || state.bot.scanning) stopBot("Deriv account disconnected; bot stopped.");
    window.clearTimeout(state.accountTimer);
    if (state.accountSocket) {
      const socket = state.accountSocket;
      state.accountSocket = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    }
    state.accountAuthorized = null;
    state.accountType = null;
    state.accountBalance = null;
    state.orderUncertain = false;
    state.portfolioContracts.clear();
    state.openContractsSubscribed = false;
    $("#account-label").textContent = "Connect account";
    $("#account-mode-badge").textContent = "NOT CONNECTED";
    $("#account-mode-badge").classList.remove("real-account-badge");
    $("#balance-value").textContent = "—";
    $("#balance-account-type").textContent = "Not connected";
    $("#balance-currency").textContent = "Connect an account";
    $("#currency-code").textContent = "—";
    $("#currency-symbol").textContent = "¤";
    $("#trade-disclaimer").textContent = "Live market data. Connect a Deriv demo or real account to trade.";
    $("#trade-submit strong").textContent = "Connect to trade";
    $("#trade-submit small").textContent = "Review the live proposal first";
    $("#potential-payout").textContent = "Connect to request quote";
    clearPositions();
    updateTradeAvailability();
    if (notify) showToast("Deriv account disconnected.");
  }

  function base64Url(bytes) {
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function startDerivOAuth(signUp = false) {
    try {
      if (`${window.location.origin}/` !== DERIV_REDIRECT_URI) {
        throw new Error("Open the published APEX site to use Deriv sign-in.");
      }
      if (!window.isSecureContext || !window.crypto?.subtle) {
        throw new Error("Secure Deriv sign-in requires the published HTTPS website.");
      }
      const verifier = base64Url(window.crypto.getRandomValues(new Uint8Array(64)));
      const stateBytes = window.crypto.getRandomValues(new Uint8Array(32));
      const oauthState = base64Url(stateBytes);
      const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      const challenge = base64Url(new Uint8Array(digest));
      sessionStorage.setItem(OAUTH_VERIFIER_KEY, verifier);
      sessionStorage.setItem(OAUTH_STATE_KEY, oauthState);

      const authorization = new URL(DERIV_AUTH_URL);
      authorization.search = new URLSearchParams({
        response_type: "code",
        client_id: DERIV_CLIENT_ID,
        redirect_uri: DERIV_REDIRECT_URI,
        scope: "trade",
        state: oauthState,
        code_challenge: challenge,
        code_challenge_method: "S256",
        ...(signUp ? { prompt: "registration" } : {})
      }).toString();
      window.location.assign(authorization.href);
    } catch (error) {
      sessionStorage.removeItem(OAUTH_VERIFIER_KEY);
      sessionStorage.removeItem(OAUTH_STATE_KEY);
      showToast(error.message || "Could not start secure Deriv sign-in.");
    }
  }

  function showOAuthDashboard() {
    state.oauthAuthenticated = true;
    $("#landing-page").hidden = true;
    $("#dashboard-app").hidden = false;
    $("#oauth-logout").hidden = false;
    $("#account-label").textContent = state.accountAuthorized
      ? (state.accountType === "real" ? "Deriv real account" : "Deriv demo account")
      : "Connect trading account";
    const accountWithBalance = state.oauthAccounts.find((account) =>
      Number.isFinite(account.balance) && /^[A-Z]{3}$/.test(account.currency)
    );
    if (accountWithBalance) {
      state.accountBalance = accountWithBalance.balance;
      $("#balance-value").textContent = money(accountWithBalance.balance, accountWithBalance.currency);
      $("#balance-account-type").textContent = accountWithBalance.accountType === "demo" ? "Demo funds" : "Real funds";
      $("#balance-currency").textContent = accountWithBalance.currency;
      $("#currency-code").textContent = accountWithBalance.currency;
      $("#currency-symbol").textContent = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: accountWithBalance.currency
      }).formatToParts(0).find((part) => part.type === "currency")?.value || accountWithBalance.currency;
    } else if (!state.accountAuthorized) {
      state.accountBalance = null;
      $("#balance-value").textContent = "—";
      $("#balance-account-type").textContent = "Deriv signed in";
      $("#balance-currency").textContent = "Connect trading account for balance";
      $("#currency-code").textContent = "—";
      $("#currency-symbol").textContent = "¤";
    }
    if (!state.accountAuthorized) {
      $("#bot-activity").textContent = "Deriv sign-in complete. Connect a trading account to place trades; market data is available without an account.";
    }
  }

  async function verifyOAuthSession() {
    const result = await fetch("/.netlify/functions/deriv-oauth-session", {
      headers: { Accept: "application/json" },
      credentials: "same-origin"
    });
    if (result.status === 401) return false;
    const payload = await result.json();
    if (!result.ok || payload.authenticated !== true) {
      throw new Error(payload.error || "Could not verify the Deriv sign-in.");
    }
    state.oauthAccounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    return payload;
  }

  async function finishDerivOAuth() {
    const callback = new URL(window.location.href);
    const code = callback.searchParams.get("code");
    const returnedState = callback.searchParams.get("state");
    const oauthError = callback.searchParams.get("error_description") || callback.searchParams.get("error");
    if (!code && !oauthError) return;

    const expectedState = sessionStorage.getItem(OAUTH_STATE_KEY);
    const verifier = sessionStorage.getItem(OAUTH_VERIFIER_KEY);
    sessionStorage.removeItem(OAUTH_STATE_KEY);
    sessionStorage.removeItem(OAUTH_VERIFIER_KEY);
    callback.searchParams.delete("code");
    callback.searchParams.delete("state");
    callback.searchParams.delete("error");
    callback.searchParams.delete("error_description");
    window.history.replaceState({}, document.title, `${callback.pathname}${callback.search}${callback.hash}`);

    if (oauthError) {
      showToast(`Deriv sign-in was not completed: ${oauthError}`);
      return;
    }
    if (!expectedState || !returnedState || returnedState !== expectedState || !verifier) {
      showToast("Deriv sign-in could not be verified. Please start again.");
      return;
    }

    try {
      const exchange = await fetch("/.netlify/functions/deriv-oauth-token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: DERIV_REDIRECT_URI })
      });
      const exchangeResult = await exchange.json();
      if (!exchange.ok || exchangeResult.authenticated !== true) {
        throw new Error(exchangeResult.error || "Deriv could not complete the sign-in.");
      }
      const session = await verifyOAuthSession();
      if (!session) {
        throw new Error("Deriv sign-in could not be verified. Please start again.");
      }
      showOAuthDashboard();
      showToast("Signed in with Deriv. Connect a trading account to place trades.");
    } catch (error) {
      showToast(error.message || "Could not complete Deriv sign-in.");
    }
  }

  async function restoreDerivOAuth() {
    try {
      const session = await verifyOAuthSession();
      if (session) showOAuthDashboard();
    } catch (error) {
      showToast(error.message || "Could not verify the Deriv session.");
    }
  }

  async function initializeDerivOAuth() {
    if (`${window.location.origin}/` !== DERIV_REDIRECT_URI) return;
    const callback = new URL(window.location.href);
    if (callback.searchParams.has("code") || callback.searchParams.has("error")) {
      await finishDerivOAuth();
      return;
    }
    await restoreDerivOAuth();
  }

  async function signOutDeriv() {
    try {
      const result = await fetch("/.netlify/functions/deriv-oauth-logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      });
      if (!result.ok) {
        const payload = await result.json();
        throw new Error(payload.error || "Could not sign out.");
      }
      disconnectAccount(false);
      state.oauthAuthenticated = false;
      $("#oauth-logout").hidden = true;
      $("#dashboard-app").hidden = true;
      $("#landing-page").hidden = false;
      showToast("Signed out of APEX.");
    } catch (error) {
      showToast(error.message || "Could not sign out of Deriv.");
    }
  }

  function connectAccount() {
    const type = $("#account-type-select").value;
    const input = $("#otp-url");
    const enteredUrl = input.value.trim();
    input.value = "";
    let parsed;
    try {
      parsed = new URL(enteredUrl);
    } catch {
      showToast("Paste the full one-time Deriv WebSocket URL.");
      return;
    }
    const expectedPath = `${ACCOUNT_WS_BASE}/${type}`;
    if (parsed.protocol !== "wss:" || parsed.hostname !== "api.derivws.com" || parsed.pathname !== expectedPath || !parsed.searchParams.has("otp")) {
      showToast(`Use the one-time WebSocket URL for a Deriv ${type} account.`);
      return;
    }
    disconnectAccount(false);
    state.accountType = type;
    $("#account-label").textContent = "Connecting…";
    $("#account-mode-badge").textContent = type === "real" ? "REAL · CONNECTING" : "DEMO · CONNECTING";
    $("#balance-value").textContent = "Connecting…";
    $("#balance-account-type").textContent = type === "real" ? "Real account" : "Demo account";
    $("#balance-currency").textContent = "Authenticating…";
    $("#trade-disclaimer").textContent = type === "real"
      ? "Real funds at risk. Manual trades require confirmation; the bot trades automatically after its risk confirmation."
      : "Deriv demo account. Orders use demo funds.";
    const socket = new WebSocket(parsed.href);
    state.accountSocket = socket;
    $("#account-dialog").close();
    socket.addEventListener("open", () => {
      if (state.accountSocket !== socket) return;
      state.accountTimer = window.setTimeout(() => {
        if (!state.accountAuthorized) {
          showToast("Deriv did not authenticate this WebSocket URL. Get a fresh OTP URL and reconnect.");
          disconnectAccount(false);
        }
      }, 12000);
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        receiveMessage(socket, message);
        if (message.error && !message.echo_req?.req_id) showToast(message.error.message || "Deriv account error.");
        handleAccountMessage(socket, message);
      } catch {
        showToast("Received an invalid response from Deriv.");
      }
    });
    socket.addEventListener("error", () => {
      if (state.accountSocket === socket) showToast("Could not connect to Deriv. Check your connection and OTP URL.");
    });
    socket.addEventListener("close", () => {
      if (state.accountSocket !== socket) return;
      state.accountSocket = null;
      state.accountAuthorized = null;
      if ($("#account-label").textContent !== "Connect account") disconnectAccount(false);
    });
  }

  function stopBot(reason) {
    const active = state.bot.running || state.bot.starting || state.bot.scanning;
    state.bot.running = false;
    state.bot.starting = false;
    state.bot.scanning = false;
    state.bot.scanSequence += 1;
    window.clearTimeout(state.bot.timer);
    state.bot.timer = null;
    updateBotControls();
    updateTradeAvailability();
    if (reason) {
      setBotActivity(state.bot.activeContractId
        ? `${reason} The open contract remains with Deriv and will still settle.`
        : reason);
    } else if (active) {
      setBotActivity(state.bot.activeContractId
        ? "Bot stopped. The open contract remains with Deriv and will still settle; no new trades will be placed."
        : "Bot stopped. No new trades will be placed.");
    }
  }

  function botTradeLimitReached() {
    const target = Number($("#bot-target").value);
    const lossLimit = Number($("#bot-loss-limit").value);
    const tradeLimit = Number($("#bot-trade-limit").value);
    if (state.bot.realized >= target) {
      stopBot(`Profit target reached: ${money(state.bot.realized, state.bot.currency)} realized.`);
      return true;
    }
    if (state.bot.realized <= -lossLimit) {
      stopBot(`Loss limit reached: ${money(state.bot.realized, state.bot.currency)} realized.`);
      return true;
    }
    if (state.bot.trades >= tradeLimit) {
      stopBot(`Trade limit reached after ${state.bot.trades} trades.`);
      return true;
    }
    return false;
  }

  function handleBotContractUpdate(contract) {
    if (!contract || String(contract.contract_id) !== String(state.bot.activeContractId)) return;
    if (contract.is_sold !== true && Number(contract.is_sold) !== 1) return;
    const profit = Number(contract.profit);
    if (!Number.isFinite(profit)) {
      stopBot("The settled contract returned no valid profit figure. Check your Deriv account before restarting.");
      return;
    }
    state.bot.realized += profit;
    if (profit > 0) state.bot.wins += 1;
    else if (profit < 0) state.bot.losses += 1;
    const contractId = state.bot.activeContractId;
    addBotTransaction(contract, "settled", profit);
    state.bot.activeContractId = null;
    if (state.bot.contractSubscriptionId && state.accountSocket?.readyState === WebSocket.OPEN) {
      sendRequest(state.accountSocket, { forget: state.bot.contractSubscriptionId }).catch(() => {});
    }
    state.bot.contractSubscriptionId = null;
    updateBotSummary();
    if (botTradeLimitReached()) return;
    setBotActivity(`Contract #${contractId} settled ${profit >= 0 ? "with a profit" : "at a loss"} of ${money(profit, state.bot.currency)}. Scanning for the next eligible market.`);
    updateBotControls();
    updateTradeAvailability();
    if (state.bot.running) {
      window.clearTimeout(state.bot.timer);
      state.bot.timer = window.setTimeout(runBotCycle, 1500);
    }
  }

  async function runBotCycle() {
    if (!state.bot.running || state.bot.busy || state.bot.activeContractId) return;
    const socket = state.accountSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !state.accountAuthorized || !Number.isFinite(state.accountBalance)) {
      stopBot("Deriv account disconnected or balance unavailable; bot stopped.");
      return;
    }
    if (!state.publicSocket || state.publicSocket.readyState !== WebSocket.OPEN) {
      stopBot("Deriv market feed disconnected; bot stopped.");
      return;
    }
    if (botTradeLimitReached()) return;
    state.bot.busy = true;
    updateBotControls();
    let buySent = false;
    let buyConfirmed = false;
    try {
      const { eligible } = updateBotSummary();
      const selected = eligible[0];
      if (!selected) {
        setBotActivity(`Waiting for a market to show at least ${Number($("#bot-threshold").value)}% observed ${( $("#bot-parity").value === "DIGITEVEN" ? "even" : "odd" )} digits across at least ${BOT_MIN_SAMPLES} recent ticks. This is historical frequency, not a forecast.`);
        return;
      }
      const contractType = $("#bot-parity").value;
      const symbol = selected.symbol;
      const symbolCode = symbol.underlying_symbol;
      setBotActivity(`Requesting a live ${contractType === "DIGITEVEN" ? "Even" : "Odd"} quote on ${shortName(symbol)} (${(selected.rate * 100).toFixed(1)}% observed in ${selected.sample.length} ticks).`);
      let available = state.bot.contracts.get(symbolCode);
      if (!available) {
        const contractResponse = await sendRequest(state.publicSocket, { contracts_for: symbolCode });
        available = contractResponse.contracts_for?.available || [];
        state.bot.contracts.set(symbolCode, available);
      }
      const contract = available.find((item) =>
        item.contract_type === contractType && availableUnits(item).includes("t")
      );
      if (!contract) throw new Error(`${formatContractName(contractType)} one-tick contracts are unavailable for ${shortName(symbol)}.`);
      const durationMatch = String(contract.min_contract_duration || "").match(/^(\d+)/);
      const duration = Math.max(1, Number(durationMatch?.[1]) || 1);
      const stake = Number($("#bot-stake").value);
      const minStake = Number(contract.min_stake);
      const maxStake = Number(contract.max_stake);
      if (!Number.isFinite(stake) || stake <= 0 || (Number.isFinite(minStake) && stake < minStake) || (Number.isFinite(maxStake) && stake > maxStake)) {
        throw new Error("Bot stake is outside the Deriv limits for this contract.");
      }
      if (stake > state.accountBalance) throw new Error("Bot stake exceeds the connected account balance.");
      const proposalResponse = await sendRequest(state.publicSocket, {
        proposal: 1,
        amount: stake,
        basis: "stake",
        contract_type: contractType,
        currency: state.accountAuthorized.currency || "USD",
        duration,
        duration_unit: "t",
        underlying_symbol: symbolCode
      });
      const proposal = proposalResponse.proposal;
      if (!proposal?.id || !Number.isFinite(Number(proposal.ask_price))) {
        throw new Error("Deriv returned an incomplete proposal. No order was placed.");
      }
      if (!state.bot.running) return;
      if (state.accountSocket !== socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Deriv account disconnected before the order could be sent.");
      }
      setBotActivity(`Submitting the ${contractType === "DIGITEVEN" ? "Even" : "Odd"} contract on ${shortName(symbol)}.`);
      buySent = true;
      state.orderUncertain = true;
      updateTradeAvailability();
      const buyResponse = await sendRequest(socket, {
        buy: String(proposal.id),
        price: Number(proposal.ask_price)
      }, 20000);
      const buy = buyResponse.buy;
      if (!buy?.contract_id) throw new Error("Deriv did not confirm the bot order.");
      buyConfirmed = true;
      state.orderUncertain = false;
      state.bot.activeContractId = String(buy.contract_id);
      state.bot.trades += 1;
      addBotTransaction({
        ...buy,
        contract_id: buy.contract_id,
        contract_type: contractType,
        underlying: symbolCode
      }, "open");
      $("#bot-trade-count").textContent = String(state.bot.trades);
      if (buy.balance_after !== undefined) {
        updateBalance({ balance: Number(buy.balance_after), currency: state.accountAuthorized.currency || "USD" });
      }
      updateBotSummary();
      setBotActivity(`Trade ${state.bot.trades} opened: ${contractType === "DIGITEVEN" ? "Even" : "Odd"} on ${shortName(symbol)}. Waiting for settlement.`);
      updateBotControls();
      const openResponse = await sendRequest(socket, {
        proposal_open_contract: 1,
        contract_id: buy.contract_id,
        subscribe: 1
      }, 15000);
      if (state.bot.activeContractId) state.bot.contractSubscriptionId = openResponse.subscription?.id || null;
      if (openResponse.proposal_open_contract) handleBotContractUpdate(openResponse.proposal_open_contract);
      if (state.bot.activeContractId) updateBotControls();
    } catch (error) {
      if (buySent && !buyConfirmed && !error.apiCode) {
        state.orderUncertain = true;
        stopBot("The bot order status could not be confirmed. Check your Deriv account before restarting.");
      } else {
        stopBot(`Bot halted: ${error.message}`);
      }
    } finally {
      state.bot.busy = false;
      updateBotControls();
      if (state.bot.running && !state.bot.activeContractId) {
        window.clearTimeout(state.bot.timer);
        state.bot.timer = window.setTimeout(runBotCycle, 4000);
      }
    }
  }

  async function startBot() {
    if (state.bot.running || state.bot.starting || state.bot.activeContractId) return;
    if (!builderIsReady()) {
      showToast("Add all required blocks to the Bot Builder before starting.");
      return;
    }
    const account = state.accountAuthorized;
    if (!account || state.accountSocket?.readyState !== WebSocket.OPEN) {
      setBotActivity("Connect a Deriv demo or real account before starting the bot.");
      showToast("Connect a Deriv account before starting the bot.");
      return;
    }
    if (!state.publicSocket || state.publicSocket.readyState !== WebSocket.OPEN) {
      showToast("Wait for the Deriv live market feed before starting the bot.");
      return;
    }
    const stake = Number($("#bot-stake").value);
    const target = Number($("#bot-target").value);
    const lossLimit = Number($("#bot-loss-limit").value);
    const tradeLimit = Number($("#bot-trade-limit").value);
    const threshold = Number($("#bot-threshold").value);
    if (![stake, target, lossLimit].every((value) => Number.isFinite(value) && value > 0)
      || !Number.isInteger(tradeLimit) || tradeLimit < 1 || tradeLimit > BOT_MAX_TRADES
      || !Number.isFinite(threshold) || threshold < 50 || threshold > 99) {
      showToast(`Enter valid stake and limits; maximum trades must be 1–${BOT_MAX_TRADES} and frequency threshold 50–99%.`);
      return;
    }
    if (stake > state.accountBalance) {
      showToast(`Bot stake exceeds your account balance of ${money(state.accountBalance, account.currency || "USD")}.`);
      return;
    }
    if (state.accountType === "real") {
      const accepted = window.confirm(
        `REAL ACCOUNT AUTOMATION\n\nThe bot will place ${$("#bot-parity").value === "DIGITEVEN" ? "Even" : "Odd"} one-tick trades automatically without asking you to confirm each order.\n\nStake per trade: ${money(stake, account.currency || "USD")}\nStop at realized profit: ${money(target, account.currency || "USD")}\nStop at realized loss: ${money(lossLimit, account.currency || "USD")}\nMaximum trades: ${tradeLimit}\nMinimum observed rate: ${threshold}% over at least ${BOT_MIN_SAMPLES} recent ticks\n\nHistorical digit frequency does not predict the next tick or guarantee profit. Real funds can be lost. Start automation?`
      );
      if (!accepted) return;
    }
    state.bot.starting = true;
    state.bot.currency = account.currency || "USD";
    state.bot.realized = 0;
    state.bot.trades = 0;
    state.bot.wins = 0;
    state.bot.losses = 0;
    state.bot.contracts.clear();
    updateBotSummary();
    updateBotControls();
    updateTradeAvailability();
    await scanBotMarkets();
    if (!state.bot.starting) return;
    if (state.bot.scanning) return;
    state.bot.starting = false;
    state.bot.running = true;
    updateBotControls();
    updateTradeAvailability();
    setBotActivity("Bot started. Waiting for a market to meet your observed-frequency threshold.");
    runBotCycle();
  }

  async function placeTrade(event) {
    event.preventDefault();
    const socket = state.accountSocket;
    const account = state.accountAuthorized;
    const contract = state.selectedContract;
    const amount = Number($("#stake-input").value);
    const duration = Number($("#duration-input").value);
    const contractType = contract?.contract_type;
    const symbol = state.activeSymbols.find((item) => item.underlying_symbol === state.selectedSymbol);
    if (!socket || socket.readyState !== WebSocket.OPEN || !account) {
      showToast("Connect a Deriv account before trading.");
      return;
    }
    const timed = contract?.expiry_type !== "no_expiry";
    if (!contract || !symbol || !Number.isFinite(amount) || amount <= 0 || (timed && (!Number.isInteger(duration) || duration <= 0))) {
      showToast("Enter a valid stake and contract duration.");
      return;
    }
    if (!symbol.exchange_is_open || symbol.is_trading_suspended) {
      showToast("This market is closed or temporarily suspended.");
      return;
    }
    if (!Number.isFinite(state.accountBalance)) {
      showToast("Waiting for your Deriv account balance. Try again shortly.");
      return;
    }
    const minStake = Number(contract.min_stake);
    const maxStake = Number(contract.max_stake);
    if (Number.isFinite(minStake) && minStake > 0 && amount < minStake) {
      showToast(`Minimum stake for this contract is ${money(minStake, account.currency || "USD")}.`);
      return;
    }
    if (Number.isFinite(maxStake) && maxStake > 0 && amount > maxStake) {
      showToast(`Maximum stake for this contract is ${money(maxStake, account.currency || "USD")}.`);
      return;
    }
    if (amount > state.accountBalance) {
      showToast(`Stake exceeds your account balance of ${money(state.accountBalance, account.currency || "USD")}.`);
      return;
    }
    const barrier = $("#barrier-input").value;
    if (DIGIT_CONTRACTS.has(contractType) && (!/^[0-9]$/.test(barrier))) {
      showToast("Enter a last digit from 0 to 9.");
      $("#barrier-input").focus();
      return;
    }
    const durationUnit = $("#duration-unit").value;
    const selectedVariant = contractForUnit(contractType, durationUnit) || contract;
    const variantMin = parseInt(selectedVariant.min_contract_duration, 10);
    const variantMax = parseInt(selectedVariant.max_contract_duration, 10);
    if (timed && ((Number.isFinite(variantMin) && duration < variantMin) || (Number.isFinite(variantMax) && duration > variantMax))) {
      showToast(`For ${$("#duration-unit").selectedOptions[0].text}, duration must be between ${selectedVariant.min_contract_duration} and ${selectedVariant.max_contract_duration}.`);
      return;
    }
    const parameters = {
      proposal: 1,
      amount,
      basis: "stake",
      contract_type: contractType,
      currency: account.currency || "USD",
      underlying_symbol: symbol.underlying_symbol
    };
    if (timed) {
      parameters.duration = duration;
      parameters.duration_unit = durationUnit;
    }
    if (DIGIT_CONTRACTS.has(contractType)) parameters.barrier = barrier;
    else if (REQUIRED_BARRIERS.has(contractType) || $("#barrier-input").value.trim()) parameters.barrier = $("#barrier-input").value.trim();
    if (TWO_BARRIER_CONTRACTS.has(contractType) && Number(selectedVariant.barriers) > 1) parameters.barrier2 = $("#barrier2-input").value;
    if (["MULTUP", "MULTDOWN"].includes(contractType)) parameters.multiplier = Number($("#multiplier-input").value);
    if (["MULTUP", "MULTDOWN"].includes(contractType) && $("#cancellation-input").value) parameters.cancellation = $("#cancellation-input").value;
    if (contractType === "ACCU") parameters.growth_rate = Number($("#growth-rate-input").value);
    if (["TICKHIGH", "TICKLOW"].includes(contractType)) parameters.selected_tick = Number($("#selected-tick-input").value);
    if ((DIGIT_CONTRACTS.has(contractType) || Number(selectedVariant.barriers) > 0) && !parameters.barrier) {
      showToast("Enter the contract barrier before requesting a quote.");
      return;
    }
    if (TWO_BARRIER_CONTRACTS.has(contractType) && Number(selectedVariant.barriers) > 1 && REQUIRED_BARRIERS.has(contractType) && !parameters.barrier2) {
      showToast("Enter the second contract barrier before requesting a quote.");
      return;
    }
    if (["MULTUP", "MULTDOWN"].includes(contractType) && (!Number.isFinite(parameters.multiplier) || parameters.multiplier < 1)) {
      showToast("Enter a valid multiplier.");
      return;
    }
    state.proposalBusy = true;
    let buySent = false;
    updateTradeAvailability();
    $("#potential-payout").textContent = "Requesting proposal…";
    try {
      const proposalResponse = await sendRequest(state.publicSocket, parameters);
      const proposal = proposalResponse.proposal;
      if (!proposal?.id || !Number.isFinite(Number(proposal.ask_price))) {
        throw new Error("Deriv returned an incomplete proposal. No order was placed.");
      }
      const payout = proposalPayout(proposal, account.currency || "USD");
      $("#potential-payout").textContent = payout;
      const realWarning = state.accountType === "real"
        ? "\n\nREAL MONEY: this will submit an order to your live account."
        : "\n\nThis order uses your Deriv demo balance.";
      const durationText = timed ? `\nDuration: ${duration} ${$("#duration-unit").selectedOptions[0].text}` : "";
      const details = `Market: ${shortName(symbol)}\nContract: ${formatContractName(contractType)}\nStake: ${money(amount, account.currency || "USD")}\nPotential payout: ${payout}${durationText}${realWarning}\n\nPlace this order?`;
      if (!window.confirm(details)) {
        showToast("Order cancelled. No trade was placed.");
        return;
      }
      if (state.accountSocket !== socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Account disconnected before the order could be sent. No trade was placed.");
      }
      buySent = true;
      state.orderUncertain = true;
      updateTradeAvailability();
      const buyResponse = await sendRequest(socket, {
        buy: String(proposal.id),
        price: Number(proposal.ask_price)
      }, 20000);
      if (!buyResponse.buy?.contract_id) throw new Error("Order could not be confirmed by Deriv.");
      state.orderUncertain = false;
      if (buyResponse.buy.balance_after !== undefined) {
        updateBalance({ balance: Number(buyResponse.buy.balance_after), currency: account.currency || "USD" });
      }
      sendRequest(socket, { portfolio: 1 }).then((response) => renderPortfolio(response.portfolio?.contracts || []))
        .catch((error) => showToast(`Order placed, but portfolio refresh failed: ${error.message}`));
      showToast(`Order placed successfully. Contract #${buyResponse.buy.contract_id}.`);
    } catch (error) {
      if (buySent && !error.apiCode) {
        state.orderUncertain = true;
        showToast("Order status could not be confirmed. Check your Deriv account before retrying; disconnect and reconnect to refresh.");
      } else {
        showToast(error.message);
      }
    } finally {
      state.proposalBusy = false;
      updateTradeAvailability();
    }
  }

  function setupInteractions() {
    $("#welcome-date").innerHTML = `${new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "2-digit", year: "numeric" }).format(new Date()).toUpperCase()} <span class="eyebrow-divider">·</span> ${new Date().getHours() < 12 ? "GOOD MORNING" : new Date().getHours() < 17 ? "GOOD AFTERNOON" : "GOOD EVENING"}`;
    $("#market-select").addEventListener("change", (event) => setSelectedSymbol(event.target.value));
    $("#contract-select").addEventListener("change", (event) => setSelectedContract(event.target.value));
    $("#duration-unit").addEventListener("change", (event) => {
      state.selectedContract = contractForUnit($("#contract-select").value, event.target.value);
      configureDuration(state.selectedContract, event.target.value);
      updateContractFields($("#contract-select").value, state.selectedContract);
    });
    $("#stake-input").addEventListener("input", () => {
      const amount = Number($("#stake-input").value);
      $("#potential-payout").textContent = Number.isFinite(amount) && amount > 0 && state.accountAuthorized
        ? "Request a fresh proposal"
        : "Connect to request quote";
    });
    $("#trade-form").addEventListener("submit", placeTrade);
    $("#bot-scan").addEventListener("click", scanBotMarkets);
    $("#bot-start").addEventListener("click", startBot);
    $("#bot-stop").addEventListener("click", () => stopBot());
    $("#builder-quick").addEventListener("click", () => {
      state.bot.builderBlocks = [...BOT_BLOCK_ORDER];
      renderBotBuilder();
      updateBotControls();
      setBotActivity("Quick strategy loaded. Review the Even / Odd settings and limits before you run the bot.");
    });
    $("#builder-reset").addEventListener("click", () => {
      state.bot.builderBlocks = [];
      renderBotBuilder();
      updateBotControls();
      setBotActivity("Workspace cleared. Add the required strategy blocks or load Quick strategy.");
    });
    $("#builder-search").addEventListener("input", (event) => {
      const query = event.target.value.trim().toLowerCase();
      $$(".builder-tool").forEach((button) => {
        button.hidden = query !== "" && !button.textContent.toLowerCase().includes(query);
      });
    });
    $("#builder-zoom-in").addEventListener("click", () => {
      state.bot.zoom = Math.min(140, state.bot.zoom + 10);
      updateBotControls();
    });
    $("#builder-zoom-out").addEventListener("click", () => {
      state.bot.zoom = Math.max(70, state.bot.zoom - 10);
      updateBotControls();
    });
    $$(".bot-output-tabs [data-output-tab]").forEach((button) => button.addEventListener("click", () => {
      const selectedTab = button.dataset.outputTab;
      $$(".bot-output-tabs [data-output-tab]").forEach((tab) => {
        const selected = tab === button;
        tab.classList.toggle("selected", selected);
        tab.setAttribute("aria-selected", String(selected));
      });
      $$(".bot-output-panel").forEach((panel) => { panel.hidden = panel.id !== `bot-output-${selectedTab}`; });
    }));
    $("#bot-parity").addEventListener("change", updateBotSummary);
    $("#bot-threshold").addEventListener("input", updateBotSummary);
    $("#bot-digit-market").addEventListener("change", (event) => {
      state.bot.monitorSymbol = event.target.value;
      state.bot.flowSignature = "";
      updateBotSummary();
    });
    $$(".builder-tool").forEach((button) => button.addEventListener("click", () => toggleBuilderBlock(button.dataset.builderBlock)));
    ["#bot-parity", "#bot-stake", "#bot-target", "#bot-loss-limit", "#bot-trade-limit", "#bot-threshold"].forEach((selector) => {
      $(selector).addEventListener("input", updateBotBuilderValues);
      $(selector).addEventListener("change", updateBotBuilderValues);
    });
    $("#account-switch").addEventListener("click", () => $("#account-dialog").showModal());
    $("#landing-login").addEventListener("click", (event) => {
      event.preventDefault();
      startDerivOAuth();
    });
    $("#landing-signup").addEventListener("click", (event) => {
      event.preventDefault();
      startDerivOAuth(true);
    });
    $("#oauth-logout").addEventListener("click", signOutDeriv);
    $("#connect-account").addEventListener("click", connectAccount);
    $("#disconnect-account").addEventListener("click", () => {
      disconnectAccount();
      $("#account-dialog").close();
    });
    $("#account-type-select").addEventListener("change", (event) => {
      $("#otp-url").placeholder = `wss://api.derivws.com/trading/v1/options/ws/${event.target.value}?otp=…`;
    });
    $("#otp-url").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        connectAccount();
      }
    });
    $("#export-report").addEventListener("click", () => {
      const rows = [["Market", "Contract", "Stake", "Status"]];
      $$(".position-row", $("#position-list")).forEach((row) => {
        rows.push([
          $(".position-info strong", row)?.textContent || "",
          $(".position-info small", row)?.textContent || "",
          $(".position-result", row)?.textContent || "",
          $(".position-result small", row)?.textContent || ""
        ]);
      });
      const csv = rows.map((row) => row.map((field) => `"${String(field).replaceAll('"', '""')}"`).join(",")).join("\r\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "deriv-account-report.csv";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast("Account report exported.");
    });
    $("#notification-button")?.addEventListener("click", () => showToast("No new notifications."));
    $("#expand-chart").addEventListener("click", () => {
      const panel = $(".chart-panel");
      panel.classList.toggle("chart-expanded");
      $("#expand-chart").setAttribute("aria-label", panel.classList.contains("chart-expanded") ? "Close expanded chart" : "Expand chart");
    });
    $(".chart-type-button").addEventListener("click", (event) => {
      const area = $("#chart-area");
      const isArea = area.style.display !== "none";
      area.style.display = isArea ? "none" : "";
      event.currentTarget.innerHTML = `▥ <span>${isArea ? "Line" : "Area"}</span>⌄`;
    });
    $$(".timeframes button").forEach((button) => button.addEventListener("click", () => {
      $$(".timeframes button").forEach((item) => item.classList.toggle("selected", item === button));
      state.selectedTimeframe = button.dataset.timeframe;
      loadChartHistory(state.selectedSymbol, state.selectedTimeframe);
    }));
    $("#menu-toggle").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
    $$(".nav-link").forEach((link) => link.addEventListener("click", () => {
      $$(".nav-link").forEach((item) => item.classList.toggle("active", item === link));
      $("#sidebar").classList.remove("open");
    }));
    window.addEventListener("beforeunload", () => {
      window.clearTimeout(state.reconnectTimer);
      window.clearTimeout(state.accountTimer);
      state.publicSocket?.close();
      state.accountSocket?.close();
    });
  }

  setupInteractions();
  clearPositions();
  renderBotBuilder();
  updateBotControls();
  updateBotSummary();
  connectPublicFeed();
  initializeDerivOAuth();
})();
