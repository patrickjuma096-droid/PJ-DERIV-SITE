const COOKIE_NAME = "__Host-apex_deriv_oauth";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { Allow: "POST", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: "Method not allowed." })
    };
  }

  const requestHeaders = event.headers || {};
  const origin = requestHeaders.origin || requestHeaders.Origin;
  if (origin && origin !== "https://apex-tradershub.netlify.app") {
    return {
      statusCode: 403,
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify({ error: "Request origin is not allowed." })
    };
  }

  return {
    statusCode: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": `${COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`
    },
    body: JSON.stringify({ authenticated: false })
  };
};
