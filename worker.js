var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// Only these origins are allowed to call this API from a browser.
// Add any other domains (e.g. a staging URL) here if needed.
const ALLOWED_ORIGINS = [
  "https://one-waybharat.com",
  "https://www.one-waybharat.com"
];

// Basic abuse protection: max requests per IP per 60-second window, per endpoint.
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_SECONDS = 60;

// OTP endpoints get a tighter per-IP cap than the Places proxy.
const OTP_SEND_RATE_LIMIT_MAX = 5;
const OTP_VERIFY_RATE_LIMIT_MAX = 10;

// Meta WhatsApp Cloud API version. Check Meta's docs occasionally for the
// current stable version: https://developers.facebook.com/docs/graph-api/changelog
const WHATSAPP_API_VERSION = "v21.0";


// ── Security headers — added to every response ───────────────────────────────
function addSecurityHeaders(response) {
  const h = new Headers(response.headers);
  h.set("X-Content-Type-Options",  "nosniff");
  h.set("X-Frame-Options",         "DENY");
  h.set("Referrer-Policy",         "strict-origin-when-cross-origin");
  h.set("Permissions-Policy",      "camera=(), microphone=(), geolocation=()");
  h.set("Strict-Transport-Security","max-age=31536000; includeSubDomains; preload");
  h.set(
    "Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' https://checkout.razorpay.com https://maps.googleapis.com https://fonts.googleapis.com; " +
    "style-src 'self' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self' https://maps.googleapis.com https://graph.facebook.com https://api.razorpay.com https://checkout.razorpay.com https://lumberjack.razorpay.com; " +
    "frame-src https://api.razorpay.com https://checkout.razorpay.com; " +
    "object-src 'none'; " +
    "base-uri 'self';"
  );
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}

// ── Input sanitiser — strips HTML/script tags from string inputs ─────────────
function sanitizeString(str, maxLen = 500) {
  if (typeof str !== "string") return "";
  return str.replace(/<[^>]*>/g, "").replace(/[<>"'`;]/g, "").trim().slice(0, maxLen);
}

// ── Phone number server-side validation ──────────────────────────────────────
function validatePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length === 10 ? digits : null;
}

var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : null;

    // health — always works, no secrets needed. GET /api/health
    if (url.pathname === "/api/health" || url.pathname === "/api/health/") {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // payment/ping — tests Razorpay key validity. GET /api/payment/ping
    if (url.pathname.includes("payment/ping")) {
      return addSecurityHeaders(await handlePaymentPing(request, env, allowOrigin));
    }

    // payment/test-order — actually attempts to create a ₹1 order, shows full Razorpay response
    // Use this to diagnose why create-order is failing. DELETE after debugging.
    if (url.pathname.includes("payment/test-order")) {
      return addSecurityHeaders(await handleTestOrder(request, env, allowOrigin));
    }

    // 0. Razorpay endpoints (order creation + payment signature verification)
    if (url.pathname.includes("payment/create-order")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "payment-create", () => handleCreateOrder(request, env, allowOrigin), allowOrigin, 10))
    }
    if (url.pathname.includes("payment/verify")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "payment-verify", () => handleVerifyPayment(request, env, allowOrigin), allowOrigin, 10))
    }

    // 1. OTP endpoints (booking-flow phone verification via WhatsApp)
    // otp/ping — diagnoses WhatsApp config. GET /api/otp/ping
    if (url.pathname.includes("otp/ping")) {
      return addSecurityHeaders(await handleOtpPing(request, env, allowOrigin));
    }

    if (url.pathname.includes("otp/send")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "otp-send", () => handleSendOtp(request, env, allowOrigin), allowOrigin, OTP_SEND_RATE_LIMIT_MAX))
    }
    if (url.pathname.includes("otp/verify")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "otp-verify", () => handleVerifyOtp(request, env, allowOrigin), allowOrigin, OTP_VERIFY_RATE_LIMIT_MAX))
    }

    // 2. Booking notification (admin WhatsApp alert when booking confirmed)
    if (url.pathname.includes("booking/notify")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "notify", () => handleBookingNotify(request, env, allowOrigin), allowOrigin))
    }

    // 2b. Customer confirmation (WhatsApp message to customer after payment)
    if (url.pathname.includes("booking/customer-confirm")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "customer-confirm", () => handleCustomerConfirm(request, env, allowOrigin), allowOrigin))
    }

    // 2. Distance Matrix endpoint — used by booking modal to get road distance + ETA
    if (url.pathname.includes("distance")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "distance", () => handleDistance(request, url, env, allowOrigin), allowOrigin))
    }

    // 3. Details endpoint logic (Matches detail, details, or place_id queries)
    if (url.pathname.includes("detail") || url.searchParams.has("place_id")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "details", () => handlePlaceDetails(request, url, env, allowOrigin), allowOrigin))
    }

    // 4. Broad Autocomplete logic (Matches /api/places, /api/place, /api/autocomplete)
    if (url.pathname.includes("place") || url.pathname.includes("autocomplete")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "places", () => handlePlacesProxy(request, url, env, allowOrigin), allowOrigin))
    }

    // Fallback response if asset router runs out of scope
    return addSecurityHeaders(new Response("Not found.", { status: 404 }));
  }
};

// ── Rate limiting (Workers KV, fixed-window counter per IP+endpoint) ──────────
async function withRateLimit(request, env, ctx, bucket, handler, allowOrigin, max = RATE_LIMIT_MAX) {
  if (request.method === "OPTIONS") return corsPreflight(allowOrigin);

  // If no KV binding is configured, skip limiting rather than break the API.
  if (!env.RATE_LIMIT_KV) return handler();

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const windowId = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
  const key = `rl:${bucket}:${ip}:${windowId}`;

  try {
    const current = parseInt((await env.RATE_LIMIT_KV.get(key)) || "0", 10);
    if (current >= max) {
      return jsonResponse({ error: "Too many requests, please slow down." }, 429, allowOrigin);
    }
    // The increment write doesn't need to block the response, but it DOES
    // need to actually finish — Workers can terminate the execution context
    // right after the response is returned, killing any promise that isn't
    // either awaited or tracked via ctx.waitUntil(). Using waitUntil here
    // keeps the request fast while still guaranteeing the write completes.
    const writePromise = ctx_safe_put(env, key, String(current + 1), RATE_LIMIT_WINDOW_SECONDS + 10);
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(writePromise);
    } else {
      await writePromise; // fallback if ctx isn't available for some reason
    }
  } catch (err) {
    // If KV has a hiccup, fail open rather than taking the API down.
    console.error("Rate limit check failed:", err.message);
  }

  return handler();
}
__name(withRateLimit, "withRateLimit");

async function ctx_safe_put(env, key, value, ttl) {
  try {
    await env.RATE_LIMIT_KV.put(key, value, { expirationTtl: ttl });
  } catch (err) {
    console.error("Rate limit KV write failed:", err.message);
  }
}
__name(ctx_safe_put, "ctx_safe_put");

// ── OTP: ping / diagnostic ──────────────────────────────────────────────────
// GET https://one-waybharat.com/api/otp/ping — checks WhatsApp config + token validity
async function handleOtpPing(request, env, allowOrigin) {
  const accessToken   = env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  const templateName  = env.WHATSAPP_OTP_TEMPLATE_NAME;

  const secrets = {
    WHATSAPP_ACCESS_TOKEN:    !!accessToken,
    WHATSAPP_PHONE_NUMBER_ID: !!phoneNumberId,
    WHATSAPP_OTP_TEMPLATE_NAME: templateName || "NOT SET"
  };

  if (!accessToken || !phoneNumberId) {
    return jsonResponse({ secrets, error: "Missing secrets" }, 200, allowOrigin);
  }

  // Check token validity by fetching the phone number info
  let tokenOk = false, tokenError = null, phoneInfo = null;
  try {
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,status`,
      { headers: { "Authorization": `Bearer ${accessToken}` } }
    );
    const d = await r.json();
    if (r.ok) {
      tokenOk = true;
      phoneInfo = { display_phone: d.display_phone_number, name: d.verified_name, quality: d.quality_rating, status: d.status };
    } else {
      tokenError = d?.error?.message || JSON.stringify(d);
    }
  } catch (e) { tokenError = e.message; }

  // Check if the template exists and is approved
  let templateOk = false, templateError = null, templateInfo = null;
  if (tokenOk) {
    try {
      // Get WABA ID from phone number
      const r2 = await fetch(
        `https://graph.facebook.com/v21.0/${phoneNumberId}?fields=whatsapp_business_account`,
        { headers: { "Authorization": `Bearer ${accessToken}` } }
      );
      const d2 = await r2.json();
      const wabaId = d2?.whatsapp_business_account?.id;
      if (wabaId) {
        const r3 = await fetch(
          `https://graph.facebook.com/v21.0/${wabaId}/message_templates?name=${templateName}&fields=name,status,components`,
          { headers: { "Authorization": `Bearer ${accessToken}` } }
        );
        const d3 = await r3.json();
        const tmpl = d3?.data?.[0];
        if (tmpl) {
          templateOk = tmpl.status === "APPROVED";
          templateInfo = { name: tmpl.name, status: tmpl.status };
          if (!templateOk) templateError = `Template status: ${tmpl.status} (must be APPROVED)`;
        } else {
          templateError = `Template "${templateName}" not found in WhatsApp Business account`;
        }
      }
    } catch (e) { templateError = e.message; }
  }

  return jsonResponse({
    secrets,
    token_valid: tokenOk,
    token_error: tokenError,
    phone_number_info: phoneInfo,
    template_approved: templateOk,
    template_error: templateError,
    template_info: templateInfo
  }, 200, allowOrigin);
}

// ── OTP: send via WhatsApp ─────────────────────────────────────────────────
async function handleSendOtp(request, env, allowOrigin) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400, allowOrigin);
  }

  const rawPhone = validatePhone(body.phone);
  if (!rawPhone) {
    return jsonResponse({ error: "Enter a valid 10-digit mobile number" }, 400, allowOrigin);
  }

  if (!env.RATE_LIMIT_KV) {
    console.error("RATE_LIMIT_KV not bound — cannot store OTP");
    return jsonResponse({ error: "Service temporarily unavailable" }, 500, allowOrigin);
  }

  // Per-phone send limit (separate from the per-IP limit above): max 3 sends
  // per 10 minutes. Stops someone using this endpoint to spam a third
  // party's WhatsApp by entering a phone number that isn't theirs.
  const phoneRlKey = `otp-rl:${rawPhone}`;
  let sentCount = 0;
  try {
    sentCount = parseInt((await env.RATE_LIMIT_KV.get(phoneRlKey)) || "0", 10);
  } catch (err) {
    console.error("OTP phone rate check failed:", err.message);
  }
  if (sentCount >= 3) {
    return jsonResponse({ error: "Too many OTP requests for this number. Please try again in a few minutes." }, 429, allowOrigin);
  }

  const accessToken = env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  const templateName = env.WHATSAPP_OTP_TEMPLATE_NAME;
  if (!accessToken || !phoneNumberId || !templateName) {
    console.error("WhatsApp OTP secrets not configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_OTP_TEMPLATE_NAME)");
    return jsonResponse({ error: "OTP service is not yet configured" }, 500, allowOrigin);
  }

  const otp = generateOtp();
  const e164 = `91${rawPhone}`; // India country code, digits only, no leading '+' — required by WhatsApp Cloud API

  try {
    const waRes = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      // NOTE: the "components" structure below assumes an Authentication-category
      // template with a one-time-passcode "Copy Code" button, which is what Meta
      // recommends for OTP. When you create this template in WhatsApp Manager,
      // Meta shows you the exact sample request for YOUR template — match that
      // exactly, since the button parameter shape varies by button type
      // (copy_code vs one-tap autofill vs url).
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: e164,
        type: "template",
        template: {
          name: templateName,
          language: { code: "en" },
          components: [
            { type: "body", parameters: [{ type: "text", text: otp }] },
            { type: "button", sub_type: "copy_code", index: "0", parameters: [{ type: "coupon_code", coupon_code: otp }] }
          ]
        }
      })
    });

    const waData = await waRes.json();
    if (!waRes.ok) {
      const waErr = waData?.error?.message || waData?.error?.error_data?.details || JSON.stringify(waData);
      const waCode = waData?.error?.code || waData?.error?.error_subcode || 'unknown';
      console.error("WhatsApp send failed:", JSON.stringify(waData));
      // Return the actual WhatsApp error so the frontend can display it
      return jsonResponse({
        error: `WhatsApp error (${waCode}): ${waErr}`,
        wa_error_code: waCode,
        wa_error_type: waData?.error?.type || null
      }, 502, allowOrigin);
    }
  } catch (err) {
    console.error("WhatsApp API request failed:", err.message);
    return jsonResponse({ error: "Network error reaching WhatsApp: " + err.message }, 502, allowOrigin);
  }

  try {
    // OTP valid for 5 minutes, fresh attempt counter
    await env.RATE_LIMIT_KV.put(`otp:${rawPhone}`, JSON.stringify({ code: otp, attempts: 0 }), { expirationTtl: 300 });
    // Bump the per-phone send counter (10 min window)
    await env.RATE_LIMIT_KV.put(phoneRlKey, String(sentCount + 1), { expirationTtl: 600 });
  } catch (err) {
    console.error("OTP KV write failed:", err.message);
    return jsonResponse({ error: "Could not send OTP. Please try again." }, 500, allowOrigin);
  }

  return jsonResponse({ success: true, message: "OTP sent" }, 200, allowOrigin);
}
__name(handleSendOtp, "handleSendOtp");

// ── OTP: verify code ────────────────────────────────────────────────────────
async function handleVerifyOtp(request, env, allowOrigin) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400, allowOrigin);
  }

  const rawPhone = validatePhone(body.phone);
  const code = String(body.code || "").replace(/\D/g, "");
  if (!rawPhone || code.length !== 6) {
    return jsonResponse({ error: "Invalid phone number or code" }, 400, allowOrigin);
  }

  if (!env.RATE_LIMIT_KV) {
    console.error("RATE_LIMIT_KV not bound — cannot verify OTP");
    return jsonResponse({ error: "Service temporarily unavailable" }, 500, allowOrigin);
  }

  const key = `otp:${rawPhone}`;
  let record = null;
  try {
    const raw = await env.RATE_LIMIT_KV.get(key);
    if (raw) record = JSON.parse(raw);
  } catch (err) {
    console.error("OTP KV read failed:", err.message);
  }

  if (!record) {
    return jsonResponse({ error: "Code expired or not requested. Please resend." }, 400, allowOrigin);
  }

  if (record.attempts >= 5) {
    await ctx_safe_delete(env, key);
    return jsonResponse({ error: "Too many incorrect attempts. Please resend a new code." }, 429, allowOrigin);
  }

  if (record.code !== code) {
    record.attempts += 1;
    await ctx_safe_put(env, key, JSON.stringify(record), 300);
    return jsonResponse({ error: "Incorrect code. Please try again." }, 400, allowOrigin);
  }

  // Correct — consume the OTP (one-time use) and issue a short-lived
  // verification token. A real booking-submission endpoint should require
  // and re-validate this token server-side rather than trusting a
  // client-side "verified" flag, otherwise OTP can be bypassed via devtools.
  await ctx_safe_delete(env, key);
  const token = generateToken();
  try {
    await env.RATE_LIMIT_KV.put(`verified:${rawPhone}`, token, { expirationTtl: 1800 }); // 30 min — long enough to finish a booking
  } catch (err) {
    console.error("Verification token write failed:", err.message);
  }

  return jsonResponse({ verified: true, token }, 200, allowOrigin);
}
__name(handleVerifyOtp, "handleVerifyOtp");

async function ctx_safe_delete(env, key) {
  try {
    await env.RATE_LIMIT_KV.delete(key);
  } catch (err) {
    console.error("KV delete failed:", err.message);
  }
}
__name(ctx_safe_delete, "ctx_safe_delete");

function generateOtp() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(100000 + (arr[0] % 900000)); // 6-digit, 100000–999999
}
__name(generateOtp, "generateOtp");

function generateToken() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  let str = "";
  for (const b of arr) str += String.fromCharCode(b);
  return btoa(str).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
}
__name(generateToken, "generateToken");

// ── Distance Matrix proxy ───────────────────────────────────────────────────
// Returns road distance (km) + duration (minutes + human text) between two
// Indian locations using Google Distance Matrix API.
// Query params: ?origin=<text>&destination=<text>
async function handleDistance(request, url, env, allowOrigin) {
  const origin      = (url.searchParams.get("origin")      || "").trim();
  const destination = (url.searchParams.get("destination") || "").trim();

  if (!origin || !destination) {
    return jsonResponse({ error: "origin and destination are required" }, 400, allowOrigin);
  }
  if (origin.length > 300 || destination.length > 300) {
    return jsonResponse({ error: "location string too long" }, 400, allowOrigin);
  }

  const apiKey = env.GOOGLE_PLACES_API_KEY; // reuse same key — Distance Matrix uses it
  if (!apiKey) {
    console.error("GOOGLE_PLACES_API_KEY not set — Distance Matrix unavailable");
    return jsonResponse({ error: "Distance service temporarily unavailable" }, 500, allowOrigin);
  }

  const dmUrl = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  dmUrl.searchParams.set("origins",      origin);
  dmUrl.searchParams.set("destinations", destination);
  dmUrl.searchParams.set("key",          apiKey);
  dmUrl.searchParams.set("region",       "IN");
  dmUrl.searchParams.set("language",     "en");
  dmUrl.searchParams.set("units",        "metric");

  try {
    const res  = await fetch(dmUrl.toString());
    const data = await res.json();

    const element = data?.rows?.[0]?.elements?.[0];
    if (!element || element.status !== "OK") {
      return jsonResponse(
        { error: "Could not calculate distance", status: element?.status || "UNKNOWN" },
        200, allowOrigin
      );
    }

    const distanceMeters  = element.distance?.value  || 0;
    const durationSeconds = element.duration?.value  || 0;
    const distanceKm      = Math.round(distanceMeters / 1000);
    const durationMins    = Math.round(durationSeconds / 60);
    const hrs  = Math.floor(durationMins / 60);
    const mins = durationMins % 60;
    const durationText = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

    return jsonResponse({
      distanceKm,
      durationMins,
      distanceText: element.distance?.text || `${distanceKm} km`,
      durationText,
      origin:      data.origin_addresses?.[0]  || origin,
      destination: data.destination_addresses?.[0] || destination,
    }, 200, allowOrigin);

  } catch (err) {
    console.error("Distance Matrix upstream error:", err.message);
    return jsonResponse({ error: "Upstream request failed" }, 502, allowOrigin);
  }
}
__name(handleDistance, "handleDistance");

// ── Booking notification — WhatsApp admin alert ─────────────────────────────
// Called by the modal after OTP is verified (booking confirmed) and after
// successful Razorpay payment. Sends a formatted WhatsApp message to the
// admin number so no booking slips through unnoticed.
async function handleBookingNotify(request, env, allowOrigin) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin);
  }

  const b = body.booking || {};
  if (!b.id || !b.name || !b.phone) {
    return jsonResponse({ error: "Missing required booking fields" }, 400, allowOrigin);
  }

  // #16: Validate verifyToken — payment notifications (type==="payment") are
  // exempt since they're triggered only after server-side Razorpay signature
  // verification. Booking notifications must carry the OTP-issued token.
  const isPayment = b.type === "payment";
  if (!isPayment) {
    const submittedToken = String(body.verifyToken || "");
    const rawPhone = String(b.phone || "").replace(/\D/g, "").slice(-10);
    if (!submittedToken || !rawPhone) {
      console.warn("[OWB] Booking notify rejected: missing token or phone");
      return jsonResponse({ error: "Unauthorized" }, 403, allowOrigin);
    }
    let storedToken = null;
    try { storedToken = await env.RATE_LIMIT_KV.get(`verified:${rawPhone}`); } catch (e) { /* KV hiccup */ }
    if (!storedToken || storedToken !== submittedToken) {
      console.warn("[OWB] Booking notify rejected: token mismatch for phone", rawPhone);
      return jsonResponse({ error: "Unauthorized" }, 403, allowOrigin);
    }
  }

  const adminNumber  = env.ADMIN_WHATSAPP_NUMBER || "919355757579";
  const accessToken  = env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;

  if (!accessToken || !phoneNumberId) {
    // Non-fatal — admin notification is best-effort, don't fail the booking
    console.warn("WhatsApp admin notification not configured — skipping");
    return jsonResponse({ sent: false, reason: "not_configured" }, 200, allowOrigin);
  }

  // Build the message text
  const stops = Array.isArray(b.extraCities) ? b.extraCities.filter(c => c.trim()) : [];
  const stopLine = stops.length ? `\n🛑 Stops: ${stops.join(" → ")}` : "";

  let msg;
  if (isPayment) {
    msg =
      `💳 *PAYMENT RECEIVED — One-Way Bhaarat*\n\n` +
      `🔖 Booking ID: ${b.id}\n` +
      `👤 ${b.name} · +91 ${b.phone}\n` +
      `🚗 ${b.vehicle || "—"}\n` +
      `💰 Paid: ₹${Number(b.payAmt || 0).toLocaleString("en-IN")} of ₹${Number(b.fare || 0).toLocaleString("en-IN")}\n` +
      `📲 Razorpay ID: ${b.paymentId || "—"}`;
  } else {
    msg =
      `🚕 *NEW BOOKING — One-Way Bhaarat*\n\n` +
      `🔖 ${b.id}\n` +
      `👤 ${b.name} · +91 ${b.phone}\n` +
      `📧 ${b.email || "—"}\n` +
      `🚗 ${b.vehicle || "—"} · ${b.tripType === "roundtrip" ? "Round Trip" : "One Way"}\n` +
      `📍 ${b.from || "—"}${stopLine}\n` +
      `🏁 ${b.to || "—"}\n` +
      `📅 ${b.date || "—"}${b.time ? " at " + b.time : ""}` +
      `${b.retdate ? "\n🔄 Return: " + b.retdate : ""}\n` +
      `📏 ~${b.distKm || "?"} km · ${b.pax || "—"}\n` +
      `💰 Est. Fare: ₹${Number(b.fare || 0).toLocaleString("en-IN")} · Advance: ₹${Number(b.advance || 0).toLocaleString("en-IN")}\n` +
      `${b.notes ? "📝 " + b.notes + "\n" : ""}` +
      `\nPlease assign driver and confirm. 🙏`;
  }

  try {
    const waRes = await fetch(
      `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: adminNumber,
          type: "text",
          text: { body: msg }
        })
      }
    );
    const waData = await waRes.json();
    if (!waRes.ok) {
      console.error("Admin WA notify failed:", JSON.stringify(waData));
      return jsonResponse({ sent: false, reason: "upstream_error" }, 200, allowOrigin);
    }
    return jsonResponse({ sent: true }, 200, allowOrigin);
  } catch (err) {
    console.error("Admin WA notify exception:", err.message);
    return jsonResponse({ sent: false, reason: err.message }, 200, allowOrigin);
  }
}
__name(handleBookingNotify, "handleBookingNotify");

// ── Customer confirmation — WhatsApp message to customer after payment ────────
async function handleCustomerConfirm(request, env, allowOrigin) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin);
  }

  const b = body.booking || {};
  if (!b.id || !b.phone) {
    return jsonResponse({ error: "Missing required fields" }, 400, allowOrigin);
  }

  // Validate verifyToken — same logic as booking/notify
  const submittedToken = String(body.verifyToken || "");
  const rawPhone = String(b.phone || "").replace(/\D/g, "").slice(-10);
  if (!submittedToken || !rawPhone) {
    return jsonResponse({ error: "Unauthorized" }, 403, allowOrigin);
  }
  let storedToken = null;
  try { storedToken = await env.RATE_LIMIT_KV.get(`verified:${rawPhone}`); } catch (e) { /* KV hiccup */ }
  if (!storedToken || storedToken !== submittedToken) {
    console.warn("[OWB] Customer confirm rejected: token mismatch for phone", rawPhone);
    return jsonResponse({ error: "Unauthorized" }, 403, allowOrigin);
  }

  const accessToken   = env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) {
    console.warn("WhatsApp not configured — skipping customer confirmation");
    return jsonResponse({ sent: false, reason: "not_configured" }, 200, allowOrigin);
  }

  const stops = Array.isArray(b.extraCities) ? b.extraCities.filter(c => c.trim()) : [];
  const stopLine = stops.length ? `\n🛑 Via: ${stops.join(" → ")}` : "";
  const remaining = Number(b.fare || 0) - Number(b.payAmt || 0);
  const e164 = `91${rawPhone}`;

  const msg =
    `✅ *Booking Confirmed — One-Way Bhaarat*\n\n` +
    `🔖 Booking ID: ${b.id}\n` +
    `👤 ${b.name}\n` +
    `🚗 ${b.vehicle || "—"} · ${b.tripType === "roundtrip" ? "Round Trip" : "One Way"}\n` +
    `📍 ${b.from || "—"}${stopLine}\n` +
    `🏁 ${b.to || "—"}\n` +
    `📅 ${b.date || "—"}${b.time ? " at " + b.time : ""}` +
    `${b.retdate ? "\n🔄 Return: " + b.retdate : ""}\n` +
    `📏 ~${b.distKm || "?"} km · ${b.pax || "—"}\n` +
    `💰 Total Fare: ₹${Number(b.fare || 0).toLocaleString("en-IN")}\n` +
    `✅ Paid: ₹${Number(b.payAmt || 0).toLocaleString("en-IN")}` +
    `${remaining > 0 ? ` · Balance ₹${remaining.toLocaleString("en-IN")} to driver` : " (Full paid)"}\n` +
    `${b.notes ? "📝 " + b.notes + "\n" : ""}` +
    `\nFor support: +91-93557 57579\nThank you for choosing One-Way Bhaarat! 🙏`;

  try {
    const waRes = await fetch(
      `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: e164,
          type: "text",
          text: { body: msg }
        })
      }
    );
    const waData = await waRes.json();
    if (!waRes.ok) {
      console.error("Customer WA confirm failed:", JSON.stringify(waData));
      return jsonResponse({ sent: false, reason: "upstream_error" }, 200, allowOrigin);
    }
    return jsonResponse({ sent: true }, 200, allowOrigin);
  } catch (err) {
    console.error("Customer WA confirm exception:", err.message);
    return jsonResponse({ sent: false, reason: err.message }, 200, allowOrigin);
  }
}
__name(handleCustomerConfirm, "handleCustomerConfirm");

// ── Razorpay: ping / connectivity test ──────────────────────────────────────
// Visit https://one-waybharat.com/api/payment/ping in a browser to diagnose issues.
async function handlePaymentPing(request, env, allowOrigin) {
  const keyId     = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;
  const hasKeyId  = !!keyId;
  const hasSecret = !!keySecret;
  const keyPrefix = hasKeyId ? keyId.slice(0, 14) + "…" : "NOT SET";
  const isLive    = hasKeyId && keyId.startsWith("rzp_live_");
  const isTest    = hasKeyId && keyId.startsWith("rzp_test_");

  let razorpayReachable = false;
  let razorpayError     = null;
  let razorpayStatus    = null;

  if (hasKeyId && hasSecret) {
    try {
      const basicAuth = btoa(`${keyId}:${keySecret}`);
      const r = await fetch("https://api.razorpay.com/v1/orders?count=1", {
        headers: { "Authorization": `Basic ${basicAuth}` }
      });
      razorpayStatus    = r.status;
      razorpayReachable = r.ok;
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        razorpayError = d?.error?.description || `HTTP ${r.status}: ${JSON.stringify(d)}`;
      }
    } catch (e) {
      razorpayError = e.message;
    }
  }

  return jsonResponse({
    worker_ok: true,
    secrets_present: { RAZORPAY_KEY_ID: hasKeyId, RAZORPAY_KEY_SECRET: hasSecret },
    key_prefix: keyPrefix,
    key_mode: isLive ? "LIVE" : isTest ? "TEST" : "UNKNOWN_FORMAT",
    razorpay_http_status: razorpayStatus,
    razorpay_api_reachable: razorpayReachable,
    razorpay_error: razorpayError,
    tip: isTest ? "TEST keys detected — switch to LIVE keys (rzp_live_...) for production payments" : null
  }, 200, allowOrigin);
}

// ── Razorpay: test order creation (diagnostic endpoint) ─────────────────────
// GET https://one-waybharat.com/api/payment/test-order
// Attempts to create a real ₹1 order and returns the full Razorpay response.
// DELETE this endpoint once payments are confirmed working.
async function handleTestOrder(request, env, allowOrigin) {
  const keyId     = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    return jsonResponse({ error: "Secrets not set" }, 500, allowOrigin);
  }
  try {
    const basicAuth = btoa(`${keyId}:${keySecret}`);
    const rpRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { "Authorization": `Basic ${basicAuth}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 100, currency: "INR", receipt: "test_diag_1", notes: { test: "diagnostic" } })
    });
    const rpData = await rpRes.json();
    return jsonResponse({
      razorpay_http_status: rpRes.status,
      razorpay_ok: rpRes.ok,
      razorpay_response: rpData,
      key_prefix: keyId.slice(0, 14) + "…"
    }, 200, allowOrigin);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, allowOrigin);
  }
}

// ── Razorpay: create order ───────────────────────────────────────────────────
// Frontend calls this BEFORE opening the Razorpay checkout widget. Creating
// the order server-side (rather than trusting a client-supplied amount)
// means the amount that gets charged is always the amount we set, and gives
// us an order_id we can later use to verify the payment signature.
async function handleCreateOrder(request, env, allowOrigin) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400, allowOrigin);
  }

  const amountRupees = Number(body.amount) || 0;
  if (amountRupees < 1 || amountRupees > 500000) {
    return jsonResponse({ error: "Invalid payment amount" }, 400, allowOrigin);
  }

  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    console.error("Razorpay secrets not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)");
    return jsonResponse({ error: "Payment service is not yet configured" }, 500, allowOrigin);
  }

  const bookingId = String(body.bookingId || "").slice(0, 40);
  // Razorpay receipts have a 40-char limit.
  const receipt = (bookingId ? `oneway_${bookingId}` : `oneway_${Date.now()}`).slice(0, 40);

  try {
    const basicAuth = btoa(`${keyId}:${keySecret}`);
    const rpRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basicAuth}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        amount: Math.round(amountRupees * 100), // Razorpay wants paise, not rupees
        currency: "INR",
        receipt,
        notes: { booking_id: bookingId || "" }
      })
    });

    const rpData = await rpRes.json();
    if (!rpRes.ok) {
      const errCode = rpData?.error?.code || 'unknown';
      const errDesc = rpData?.error?.description || JSON.stringify(rpData);
      console.error(`Razorpay order creation failed [${rpRes.status}] code=${errCode}: ${errDesc}`);
      // Always return the full Razorpay error so the browser UI can display it
      return jsonResponse({
        error: `Razorpay ${errCode}: ${errDesc}`,
        debug_code: errCode,
        debug_http: rpRes.status
      }, 502, allowOrigin);
    }

    // key_id (the Razorpay "Key ID") is the public half of the pair — safe to
    // hand back to the browser, that's exactly what Checkout.js needs.
    return jsonResponse({
      order_id: rpData.id,
      amount: rpData.amount,
      currency: rpData.currency,
      key_id: keyId
    }, 200, allowOrigin);

  } catch (err) {
    console.error("Razorpay order request failed:", err.message);
    return jsonResponse({ error: "Could not initiate payment. Please try again." }, 502, allowOrigin);
  }
}
__name(handleCreateOrder, "handleCreateOrder");

// ── Razorpay: verify payment signature ──────────────────────────────────────
// Called after Checkout.js's handler() fires client-side. NEVER trust the
// client's "payment succeeded" callback alone — it can be forged via
// devtools. The signature can only have been produced by someone holding
// RAZORPAY_KEY_SECRET, which lives only on this server.
async function handleVerifyPayment(request, env, allowOrigin) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400, allowOrigin);
  }

  const orderId   = String(body.razorpay_order_id   || "");
  const paymentId = String(body.razorpay_payment_id || "");
  const signature  = String(body.razorpay_signature  || "");

  if (!orderId || !paymentId || !signature) {
    return jsonResponse({ verified: false, error: "Missing payment fields" }, 400, allowOrigin);
  }

  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (!keySecret) {
    console.error("RAZORPAY_KEY_SECRET not configured — cannot verify payment");
    return jsonResponse({ verified: false, error: "Payment service is not yet configured" }, 500, allowOrigin);
  }

  try {
    // Razorpay's documented verification formula:
    // expected_signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret)
    const expectedSig = await hmacSha256Hex(keySecret, `${orderId}|${paymentId}`);

    if (expectedSig !== signature) {
      console.warn("Razorpay signature mismatch for order", orderId);
      return jsonResponse({ verified: false }, 200, allowOrigin);
    }

    return jsonResponse({ verified: true, order_id: orderId, payment_id: paymentId }, 200, allowOrigin);
  } catch (err) {
    console.error("Payment verification failed:", err.message);
    return jsonResponse({ verified: false, error: "Verification failed" }, 500, allowOrigin);
  }
}
__name(handleVerifyPayment, "handleVerifyPayment");

// HMAC-SHA256 over `message` using `secret`, returned as lowercase hex.
// Uses the Web Crypto API (crypto.subtle), which is available natively in
// the Workers runtime — no extra crypto library needed.
async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return [...new Uint8Array(sigBuffer)].map(b => b.toString(16).padStart(2, "0")).join("");
}
__name(hmacSha256Hex, "hmacSha256Hex");

// ── Places Autocomplete proxy ───────────────────────────────────────────────
async function handlePlacesProxy(request, url, env, allowOrigin) {
  const input = url.searchParams.get("input") || "";
  const sessionToken = url.searchParams.get("sessiontoken") || "";
  if (input.length < 2) return jsonResponse({ predictions: [], status: "ZERO_RESULTS" }, 200, allowOrigin);
  if (input.length > 200) return jsonResponse({ error: "input too long" }, 400, allowOrigin);

  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.error("GOOGLE_PLACES_API_KEY not set in Cloudflare configuration");
    return jsonResponse({ error: "Service temporarily unavailable" }, 500, allowOrigin);
  }

  const gUrl = new URL("https://maps.googleapis.com/maps/api/place/autocomplete/json");
  gUrl.searchParams.set("input", input);
  gUrl.searchParams.set("key", apiKey);
  gUrl.searchParams.set("components", "country:in");
  gUrl.searchParams.set("language", "en");

  if (sessionToken) gUrl.searchParams.set("sessiontoken", sessionToken);

  try {
    const res = await fetch(gUrl.toString());
    const data = await res.json();

    // Pass back the complete raw payload structure so the frontend parser can read it cleanly
    return jsonResponse(data, 200, allowOrigin);
  } catch (err) {
    console.error("Places proxy upstream error:", err.message);
    return jsonResponse({ error: "Upstream request failed", status: "UNKNOWN_ERROR" }, 502, allowOrigin);
  }
}
__name(handlePlacesProxy, "handlePlacesProxy");

async function handlePlaceDetails(request, url, env, allowOrigin) {
  const placeId = url.searchParams.get("place_id") || "";
  const sessionToken = url.searchParams.get("sessiontoken") || "";
  if (!placeId) return jsonResponse({ error: "place_id required" }, 400, allowOrigin);

  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.error("GOOGLE_PLACES_API_KEY not set in Cloudflare configuration");
    return jsonResponse({ error: "Service temporarily unavailable" }, 500, allowOrigin);
  }

  const gUrl = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  gUrl.searchParams.set("place_id", placeId);
  gUrl.searchParams.set("key", apiKey);
  gUrl.searchParams.set("fields", "name,formatted_address,geometry");
  gUrl.searchParams.set("language", "en");

  if (sessionToken) gUrl.searchParams.set("sessiontoken", sessionToken);

  try {
    const res = await fetch(gUrl.toString());
    const data = await res.json();
    return jsonResponse(data, 200, allowOrigin);
  } catch (err) {
    console.error("Place details upstream error:", err.message);
    return jsonResponse({ error: "Upstream request failed" }, 502, allowOrigin);
  }
}
__name(handlePlaceDetails, "handlePlaceDetails");

function jsonResponse(data, status = 200, allowOrigin = null) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
  if (allowOrigin) headers["Access-Control-Allow-Origin"] = allowOrigin;
  return new Response(JSON.stringify(data), { status, headers });
}
__name(jsonResponse, "jsonResponse");

function corsPreflight(allowOrigin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
  if (allowOrigin) headers["Access-Control-Allow-Origin"] = allowOrigin;
  return new Response(null, { status: 204, headers });
}
__name(corsPreflight, "corsPreflight");

export {
  worker_default as default
};
