const DERIV_API_BASE = "https://api.derivws.com";
const COOKIE_NAME = "__Host-apex_deriv_oauth";
const ALLOWED_ORIGIN = "https://apex-tradershub.netlify.app";
const MAX_BODY_BYTES = 2048;

function response(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...headers
    },
    body: JSON.stringify(body)
  };
}

function cookieValue(cookieHeader, name) {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

function accountRecords(payload) {
  const candidates = [
    payload.accounts,
    payload.data?.accounts,
    payload.result?.accounts,
    payload.data?.data,
    payload.result?.data,
    payload.data,
    payload.result
  ];
  return candidates.find(Array.isArray) || [];
}

function accountId(account) {
  const nestedAccount = account.account && typeof account.account === "object" ? account.account : {};
  const id = account.account_id ?? account.accountId ?? account.loginid ??
    account.login_id ?? account.loginId ?? account.id ?? nestedAccount.account_id ??
    nestedAccount.accountId ?? nestedAccount.loginid ?? nestedAccount.login_id ?? nestedAccount.id;
  return id == null ? "" : String(id);
}

function accountType(account) {
  const rawType = String(account.account_type || account.type || "").toLowerCase();
  const isVirtual = account.is_virtual === true || account.is_virtual === 1 ||
    account.is_virtual === "1" || rawType === "demo" || rawType === "virtual";
  return isVirtual ? "demo" : "real";
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return response(405, { error: "Method not allowed." }, { Allow: "POST" });
  }

  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin;
  if (origin && origin !== ALLOWED_ORIGIN) {
    return response(403, { error: "Request origin is not allowed." });
  }

  const token = cookieValue(headers.cookie || headers.Cookie || "", COOKIE_NAME);
  if (!token) return response(401, { error: "Deriv sign-in is required." });
  if (typeof event.body !== "string" || Buffer.byteLength(event.body, "utf8") > MAX_BODY_BYTES) {
    return response(400, { error: "Invalid request body." });
  }

  let input;
  try {
    input = JSON.parse(event.body);
  } catch {
    return response(400, { error: "Invalid account selection." });
  }
  const requestedAccountId = input?.accountId;
  const requestedAccountIndex = input?.accountIndex;
  if ((typeof requestedAccountId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(requestedAccountId)) &&
    (!Number.isInteger(requestedAccountIndex) || requestedAccountIndex < 0 || requestedAccountIndex > 20)) {
    return response(400, { error: "Invalid account selection." });
  }

  try {
    const accountsResponse = await fetch(`${DERIV_API_BASE}/trading/v1/options/accounts`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (accountsResponse.status === 401 || accountsResponse.status === 403) {
      return response(401, { error: "Your Deriv sign-in has expired. Please sign in again." }, {
        "Set-Cookie": `${COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`
      });
    }
    if (!accountsResponse.ok) {
      return response(502, { error: "Could not verify your Deriv trading accounts." });
    }

    const accounts = accountRecords(await accountsResponse.json())
      .filter((account) => account && typeof account === "object" && !Array.isArray(account));
    const selectedAccount = Number.isInteger(requestedAccountIndex)
      ? accounts[requestedAccountIndex]
      : accounts.find((account) => accountId(account) === requestedAccountId);
    if (!selectedAccount) return response(403, { error: "That account is not available in your Deriv session." });
    const selectedAccountId = accountId(selectedAccount);
    if (!selectedAccountId) return response(502, { error: "Deriv did not return an ID for the selected trading account." });

    const otpResponse = await fetch(
      `${DERIV_API_BASE}/trading/v1/options/accounts/${encodeURIComponent(selectedAccountId)}/otp`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      }
    );
    if (otpResponse.status === 401 || otpResponse.status === 403) {
      return response(401, { error: "Deriv could not authorize this trading account." });
    }
    if (!otpResponse.ok) {
      return response(502, { error: "Deriv could not create a trading connection. Please try again." });
    }

    const otpData = await otpResponse.json();
    const url = otpData.data?.url;
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return response(502, { error: "Deriv returned an invalid trading connection." });
    }
    const expectedPath = `/trading/v1/options/ws/${accountType(selectedAccount)}`;
    if (parsedUrl.protocol !== "wss:" || parsedUrl.hostname !== "api.derivws.com" ||
      parsedUrl.pathname !== expectedPath || !parsedUrl.searchParams.has("otp")) {
      return response(502, { error: "Deriv returned a trading connection for the wrong account." });
    }

    return response(200, { url: parsedUrl.href, accountType: accountType(selectedAccount) });
  } catch {
    return response(502, { error: "Could not connect to Deriv. Please try again." });
  }
};
