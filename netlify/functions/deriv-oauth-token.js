const DERIV_CLIENT_ID = "34XuNXjevZ1sJCbMvkPgY";
const DERIV_REDIRECT_URI = "https://apex-tradershub.netlify.app/";
const TOKEN_ENDPOINT = "https://auth.deriv.com/oauth2/token";
const COOKIE_NAME = "__Host-apex_deriv_oauth";
const MAX_BODY_BYTES = 16_384;

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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return response(405, { error: "Method not allowed." }, { Allow: "POST" });
  }

  const requestHeaders = event.headers || {};
  const origin = requestHeaders.origin || requestHeaders.Origin;
  if (origin && origin !== "https://apex-tradershub.netlify.app") {
    return response(403, { error: "Request origin is not allowed." });
  }

  if (typeof event.body !== "string" || Buffer.byteLength(event.body, "utf8") > MAX_BODY_BYTES) {
    return response(400, { error: "Invalid request body." });
  }

  let input;
  try {
    input = JSON.parse(event.body);
  } catch {
    return response(400, { error: "Request body must be valid JSON." });
  }

  if (
    typeof input.code !== "string" || input.code.length < 1 || input.code.length > 4096 ||
    typeof input.code_verifier !== "string" || input.code_verifier.length < 43 || input.code_verifier.length > 128 ||
    !/^[A-Za-z0-9._~-]+$/.test(input.code_verifier) ||
    input.redirect_uri !== DERIV_REDIRECT_URI
  ) {
    return response(400, { error: "Invalid OAuth callback parameters." });
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: DERIV_CLIENT_ID,
    code: input.code,
    code_verifier: input.code_verifier,
    redirect_uri: DERIV_REDIRECT_URI
  });

  let tokenResponse;
  try {
    const upstream = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    tokenResponse = await upstream.json();
    if (!upstream.ok || typeof tokenResponse.access_token !== "string" || !Number.isFinite(Number(tokenResponse.expires_in))) {
      return response(502, { error: tokenResponse.error_description || tokenResponse.error || "Deriv rejected the authorization code. Please sign in again." });
    }
  } catch {
    return response(502, { error: "Could not reach Deriv to complete sign-in. Please try again." });
  }

  const expiresIn = Math.max(1, Math.min(Number(tokenResponse.expires_in), 2_592_000));
  const cookie = `${COOKIE_NAME}=${encodeURIComponent(tokenResponse.access_token)}; Path=/; Max-Age=${expiresIn}; Secure; HttpOnly; SameSite=Lax`;
  return response(200, {
    authenticated: true,
    expires_in: expiresIn,
    token_type: tokenResponse.token_type || "Bearer"
  }, { "Set-Cookie": cookie });
};
