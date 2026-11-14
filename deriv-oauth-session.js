const DERIV_API_BASE = "https://api.derivws.com";
const COOKIE_NAME = "__Host-apex_deriv_oauth";

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

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return response(405, { error: "Method not allowed." }, { Allow: "GET" });
  }

  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin;
  if (origin && origin !== "https://apex-tradershub.netlify.app") {
    return response(403, { error: "Request origin is not allowed." });
  }

  const token = cookieValue(headers.cookie || headers.Cookie || "", COOKIE_NAME);
  if (!token) return response(401, { authenticated: false });

  try {
    const upstream = await fetch(`${DERIV_API_BASE}/trading/v1/options/accounts`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (upstream.status === 401 || upstream.status === 403) {
      return response(401, { authenticated: false }, {
        "Set-Cookie": `${COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`
      });
    }
    if (!upstream.ok) {
      return response(502, { error: "Deriv sign-in succeeded, but account verification failed." });
    }

    return response(200, { authenticated: true });
  } catch {
    return response(502, { error: "Could not verify the Deriv session. Please try again." });
  }
};
