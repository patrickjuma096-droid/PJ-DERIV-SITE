const DERIV_API_BASE = "https://api.derivws.com";
const DERIV_CLIENT_ID = "34XuNXjevZ1sJCbMvkPgY";
const ALLOWED_ORIGIN = "https://apex-tradershub.netlify.app";
const MAX_BODY_BYTES = 131_072;
const MAX_ACCOUNTS = 100;
const CONTRACT_TYPES = new Set([
  "CALL", "PUT", "HIGHER", "LOWER", "DIGITDIFF", "DIGITMATCH", "DIGITOVER",
  "DIGITUNDER", "DIGITEVEN", "DIGITODD", "UPORDOWN", "EXPIRYRANGE",
  "EXPIRYRANGEE", "ONETOUCH", "NOTOUCH", "RANGE", "CALLE", "PUTE",
  "ASIANU", "ASIAND", "MULTUP", "MULTDOWN", "RESETCALL", "RESETPUT",
  "RUNHIGH", "RUNLOW", "TICKHIGH", "TICKLOW", "ACCU", "VANILLALONGCALL",
  "VANILLALONGPUT", "TURBOSLONG", "TURBOSSHORT", "EXPIRYMISS", "EXPIRYMISSE"
]);
const ALLOWED_PARAMETERS = new Set([
  "contract_type", "underlying_symbol", "currency", "amount", "basis",
  "duration", "duration_unit", "barrier", "barrier2", "multiplier",
  "cancellation", "growth_rate", "selected_tick"
]);

function response(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...headers
    },
    body: JSON.stringify(body)
  };
}

function validContractParameters(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const parameters = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_PARAMETERS.has(key)) return null;
    if (typeof value !== "string" && typeof value !== "number") return null;
    parameters[key] = value;
  }
  const amount = Number(parameters.amount);
  if (!CONTRACT_TYPES.has(parameters.contract_type) ||
    typeof parameters.underlying_symbol !== "string" ||
    !/^[A-Za-z0-9_]{1,32}$/.test(parameters.underlying_symbol) ||
    typeof parameters.currency !== "string" || !/^[A-Z]{3}$/.test(parameters.currency) ||
    !Number.isFinite(amount) || amount <= 0 ||
    parameters.basis !== "stake" && parameters.basis !== "payout") return null;
  parameters.amount = amount;

  if (parameters.duration !== undefined) {
    const duration = Number(parameters.duration);
    if (!Number.isInteger(duration) || duration < 1 ||
      !["t", "s", "m", "h", "d"].includes(parameters.duration_unit)) return null;
    parameters.duration = duration;
  }
  if (parameters.duration_unit !== undefined && !["t", "s", "m", "h", "d"].includes(parameters.duration_unit)) return null;
  for (const key of ["barrier", "barrier2"]) {
    if (parameters[key] !== undefined && (String(parameters[key]).length > 32 || !/^-?\d+(?:\.\d+)?$/.test(String(parameters[key])))) return null;
  }
  for (const key of ["multiplier", "growth_rate", "selected_tick"]) {
    if (parameters[key] !== undefined && (!Number.isFinite(Number(parameters[key])) || Number(parameters[key]) <= 0)) return null;
    if (parameters[key] !== undefined) parameters[key] = Number(parameters[key]);
  }
  if (parameters.cancellation !== undefined && !/^[A-Za-z0-9_]{1,16}$/.test(String(parameters.cancellation))) return null;
  return parameters;
}

function redactSecrets(message, accounts) {
  let redacted = message;
  for (const account of accounts) {
    if (account.token) redacted = redacted.split(account.token).join("[redacted]");
  }
  return redacted;
}

function sanitizeTransaction(transaction, accounts) {
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
    return {
      error: {
        code: "InvalidResponse",
        message: "Deriv returned an invalid account result."
      }
    };
  }
  const result = {};
  for (const key of ["account_id", "contract_id", "buy_price", "transaction_id"]) {
    if (transaction[key] !== undefined && ["string", "number"].includes(typeof transaction[key])) {
      result[key] = typeof transaction[key] === "string"
        ? redactSecrets(transaction[key], accounts).slice(0, 100)
        : transaction[key];
    }
  }
  if (transaction.error && typeof transaction.error === "object") {
    result.error = {
      code: typeof transaction.error.code === "string"
        ? redactSecrets(transaction.error.code, accounts).slice(0, 100)
        : "PurchaseFailed",
      message: typeof transaction.error.message === "string"
        ? redactSecrets(transaction.error.message, accounts).slice(0, 300)
        : "Deriv rejected this account's purchase."
    };
  }
  return result;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return response(405, { error: "Method not allowed." }, { Allow: "POST" });
  }

  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin;
  if (origin !== ALLOWED_ORIGIN) return response(403, { error: "Request origin is not allowed." });

  if (typeof event.body !== "string" || Buffer.byteLength(event.body, "utf8") > MAX_BODY_BYTES) {
    return response(400, { error: "Request is too large or invalid." });
  }

  let input;
  try {
    input = JSON.parse(event.body);
  } catch {
    return response(400, { error: "Request body must be valid JSON." });
  }

  if (!input || !["demo", "real"].includes(input.accountType) ||
    !Array.isArray(input.accounts) || input.accounts.length < 1 || input.accounts.length > MAX_ACCOUNTS) {
    return response(400, { error: "Choose an account type and provide between 1 and 100 accounts." });
  }
  const contractParameters = validContractParameters(input.contractParameters);
  if (!contractParameters) return response(400, { error: "Contract parameters are invalid or unsupported." });

  const accounts = input.accounts.map((account) => ({
    token: account?.token,
    account_id: account?.accountId
  }));
  if (accounts.some((account) =>
    typeof account.token !== "string" || account.token.length < 1 || account.token.length > 512 ||
    typeof account.account_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(account.account_id)
  )) {
    return response(400, { error: "Each account needs a valid account ID and its own PAT." });
  }

  let upstream;
  try {
    upstream = await fetch(`${DERIV_API_BASE}/trading/v1/options/contracts/bulk-purchase/${input.accountType}`, {
      method: "POST",
      headers: {
        "Deriv-App-ID": DERIV_CLIENT_ID,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ contract_parameters: contractParameters, accounts })
    });
  } catch {
    return response(502, { error: "Could not reach Deriv. No result was received; check account activity before retrying." });
  }

  let payload;
  try {
    payload = await upstream.json();
  } catch {
    return response(502, { error: "Deriv returned an unreadable response. Check account activity before retrying." });
  }
  if (!upstream.ok) {
    const upstreamError = payload && typeof payload === "object" ? payload.errors?.[0]?.message : undefined;
    return response(upstream.status === 401 ? 401 : upstream.status === 400 ? 400 : 502, {
      error: typeof upstreamError === "string"
        ? redactSecrets(upstreamError, accounts).slice(0, 300)
        : "Deriv did not accept the bulk purchase request."
    });
  }

  const transactions = payload && typeof payload === "object" ? payload.data?.transactions : undefined;
  if (!Array.isArray(transactions)) {
    return response(502, { error: "Deriv did not return per-account results. Check account activity before retrying." });
  }
  return response(200, { transactions: transactions.map((transaction) => sanitizeTransaction(transaction, accounts)) });
};
