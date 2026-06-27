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

// ── CRM (duty/booking management) config ─────────────────────────────────────
// Session tokens for admin/driver logins are valid for this long, then the
// person has to log in again. 12 hours covers a full duty shift comfortably.
const SESSION_TTL_SECONDS = 12 * 60 * 60;
// Login attempts are capped per-IP to slow down password guessing.
const LOGIN_RATE_LIMIT_MAX = 8;


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
    "connect-src 'self' https://maps.googleapis.com https://graph.facebook.com https://api.razorpay.com; " +
    "frame-src https://api.razorpay.com; " +
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

    // 0. Razorpay endpoints (order creation + payment signature verification)
    if (url.pathname.includes("payment/create-order")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "payment-create", () => handleCreateOrder(request, env, allowOrigin), allowOrigin, 10))
    }
    if (url.pathname.includes("payment/verify")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "payment-verify", () => handleVerifyPayment(request, env, allowOrigin), allowOrigin, 10))
    }

    // 1. OTP endpoints (booking-flow phone verification via WhatsApp)
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

    // 2b. Customer confirmation WhatsApp message after payment
    if (url.pathname.includes("booking/customer-confirm")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "customer-confirm", () => handleCustomerConfirm(request, env, allowOrigin), allowOrigin))
    }

    // ── CRM: auth ────────────────────────────────────────────────────────────
    if (url.pathname.includes("auth/admin-login")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "admin-login", () => handleAdminLogin(request, env, allowOrigin), allowOrigin, LOGIN_RATE_LIMIT_MAX))
    }
    if (url.pathname.includes("auth/driver-login")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "driver-login", () => handleDriverLogin(request, env, allowOrigin), allowOrigin, LOGIN_RATE_LIMIT_MAX))
    }
    if (url.pathname.includes("auth/logout")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "logout", () => handleLogout(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("auth/me")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "me", () => handleMe(request, env, allowOrigin), allowOrigin))
    }

    // ── CRM: duties (bookings) ───────────────────────────────────────────────
    if (url.pathname.includes("duty/create")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "duty-create", () => handleDutyCreate(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("duty/assign")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "duty-assign", () => handleDutyAssign(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("duty/status")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "duty-status", () => handleDutyStatus(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("duty/list")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "duty-list", () => handleDutyList(request, env, allowOrigin), allowOrigin))
    }

    // ── CRM: drivers ─────────────────────────────────────────────────────────
    if (url.pathname.includes("driver/create")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "driver-create", () => handleDriverCreate(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("driver/list")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "driver-list", () => handleDriverList(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("driver/update")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "driver-update", () => handleDriverUpdate(request, env, allowOrigin), allowOrigin))
    }

    // ── Admin: computed views (derived from existing duty records, no new storage) ──
    if (url.pathname.includes("admin/customers")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "admin-customers", () => handleCustomersList(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("admin/payments")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "admin-payments", () => handlePaymentsList(request, env, allowOrigin), allowOrigin))
    }

    // ── Admin: vehicles (simple reference list, admin-managed) ──────────────
    if (url.pathname.includes("vehicle/create")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "vehicle-create", () => handleVehicleCreate(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("vehicle/list")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "vehicle-list", () => handleVehicleList(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("vehicle/delete")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "vehicle-delete", () => handleVehicleDelete(request, env, allowOrigin), allowOrigin))
    }

    // ── Admin: routes (simple reference list, admin-managed, NOT wired to live fare calc) ──
    if (url.pathname.includes("route/create")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "route-create", () => handleRouteCreate(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("route/list")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "route-list", () => handleRouteList(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("route/delete")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "route-delete", () => handleRouteDelete(request, env, allowOrigin), allowOrigin))
    }

    // ── Admin: coupons (stored + manageable, NOT yet validated at checkout) ──
    if (url.pathname.includes("coupon/create")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "coupon-create", () => handleCouponCreate(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("coupon/list")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "coupon-list", () => handleCouponList(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("coupon/update")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "coupon-update", () => handleCouponUpdate(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("coupon/delete")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "coupon-delete", () => handleCouponDelete(request, env, allowOrigin), allowOrigin))
    }

    // ── Admin: refunds (manual admin-logged refund requests, no customer-facing flow yet) ──
    if (url.pathname.includes("refund/create")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "refund-create", () => handleRefundCreate(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("refund/list")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "refund-list", () => handleRefundList(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("refund/update")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "refund-update", () => handleRefundUpdate(request, env, allowOrigin), allowOrigin))
    }

    // ── Admin: settings (pricing rates + GST config — persisted, not yet wired
    // into the live public booking-form fare calculation) ───────────────────
    if (url.pathname.includes("settings/pricing")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "settings-pricing", () => handlePricingSettings(request, env, allowOrigin), allowOrigin))
    }

    // ── Admin: GST summary report (derived from existing duty records) ──────
    if (url.pathname.includes("admin/gst-summary")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "gst-summary", () => handleGstSummary(request, env, allowOrigin), allowOrigin))
    }

    // ── Admin: dashboard stats + analytics (derived from existing duty/driver records) ──
    if (url.pathname.includes("admin/dashboard-stats")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "dashboard-stats", () => handleDashboardStats(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("admin/analytics")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "analytics", () => handleAnalytics(request, env, allowOrigin), allowOrigin))
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

  // Try multiple template payload structures in order until one succeeds.
  // Meta error 132000 = wrong body params, 132018 = wrong button type.
  const templatePayloads = [
    // Attempt 1: body + copy_code button (standard Meta Auth template)
    { messaging_product: "whatsapp", to: e164, type: "template", template: { name: templateName, language: { code: "en" }, components: [
      { type: "body", parameters: [{ type: "text", text: otp }] },
      { type: "button", sub_type: "copy_code", index: "0", parameters: [{ type: "coupon_code", coupon_code: otp }] }
    ]}},
    // Attempt 2: copy_code button only (no body params)
    { messaging_product: "whatsapp", to: e164, type: "template", template: { name: templateName, language: { code: "en" }, components: [
      { type: "button", sub_type: "copy_code", index: "0", parameters: [{ type: "coupon_code", coupon_code: otp }] }
    ]}},
    // Attempt 3: body + url button
    { messaging_product: "whatsapp", to: e164, type: "template", template: { name: templateName, language: { code: "en" }, components: [
      { type: "body", parameters: [{ type: "text", text: otp }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: otp }] }
    ]}},
    // Attempt 4: body only
    { messaging_product: "whatsapp", to: e164, type: "template", template: { name: templateName, language: { code: "en" }, components: [
      { type: "body", parameters: [{ type: "text", text: otp }] }
    ]}},
    // Attempt 5: minimal, no components
    { messaging_product: "whatsapp", to: e164, type: "template", template: { name: templateName, language: { code: "en" } }}
  ];

  let sent = false;
  let lastError = null;
  for (const payload of templatePayloads) {
    try {
      const waRes = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const waData = await waRes.json();
      if (waRes.ok && waData?.messages?.[0]?.id) { sent = true; break; }
      lastError = waData?.error;
      console.error("OTP attempt failed:", JSON.stringify(waData));
      // Only retry on parameter/structure errors, not auth errors
      const code = waData?.error?.code;
      if (code && ![132000, 132001, 132018].includes(Number(code))) break;
    } catch (err) {
      console.error("WhatsApp API request failed:", err.message);
      lastError = { message: err.message };
      break;
    }
  }
  if (!sent) {
    return jsonResponse({ error: `Could not send OTP. Please try again.`, wa_error: lastError }, 502, allowOrigin);
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

// ── Booking notification — WhatsApp admin alert via oneway_notification_v2 template ──
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

  // Persist the duty so it shows up in the admin panel for assignment.
  // This is best-effort — a KV hiccup here should never block the WhatsApp
  // alert from going out, since that's the part the business depends on most.
  if (env.CRM_KV) {
    try { await saveDutyFromBooking(env, b); }
    catch (err) { console.error("Duty persist failed:", err.message); }
  }

  const adminNumber   = env.ADMIN_WHATSAPP_NUMBER || "919355757579";
  const supportNumber = env.ADMIN_SUPPORT_NUMBER || adminNumber;
  const accessToken   = env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  // v2 template adds: payment status, vehicle type, trip type, separate
  // pickup/drop labels, and a 24x7 support number. Falls back to the old
  // 8-param template name if WHATSAPP_NOTIFY_TEMPLATE_NAME isn't switched
  // over yet, so this keeps working before/while the new template is
  // pending Meta approval.
  const notifTemplate = env.WHATSAPP_NOTIFY_TEMPLATE_NAME || "oneway_notification_v2";

  if (!accessToken || !phoneNumberId) {
    console.warn("WhatsApp admin notification not configured — skipping");
    return jsonResponse({ sent: false, reason: "not_configured" }, 200, allowOrigin);
  }

  const stops = Array.isArray(b.extraCities) ? b.extraCities.filter(c => c.trim()) : [];

  // Template variables — must match oneway_notification_v2 exactly (12 params):
  // {{1}} Payment status   {{2}} Booking ID   {{3}} Name      {{4}} Phone
  // {{5}} Vehicle          {{6}} Trip type    {{7}} Pickup    {{8}} Drop
  // {{9}} Trip timing      {{10}} Paid amt    {{11}} Due amt  {{12}} Support number
  const isPaymentDone = b.type === "payment";
  const paymentStatus = isPaymentDone ? "Payment Completed" : "Payment Pending";
  const isRoundTrip= b.tripType === "roundtrip";
  const pickupLoc  = `${b.from || "—"}${stops.length ? " → " + stops.join(" → ") : ""}`;
  const dropLoc    = isRoundTrip ? "Same as pickup (round trip)" : (b.to || "—");
  const vehicleType= b.vehicle || "—";
  const tripType   = isRoundTrip ? "Round Trip" : "One Way";
  // Before payment actually completes, nothing has been paid yet — b.advance
  // at that point is the INTENDED amount the customer is about to pay, not
  // money already received, so it must not be shown as "Paid". Only the
  // post-payment call (type:"payment", carrying payAmt from a real Razorpay
  // success) reflects money actually collected.
  const actuallyPaid = isPaymentDone ? Number(b.payAmt || b.advance || 0) : 0;
  const paidAmt    = `₹${actuallyPaid.toLocaleString("en-IN")}`;
  const dueAmt     = `₹${Number((b.fare || 0) - actuallyPaid).toLocaleString("en-IN")}`;
  const tripTiming = isRoundTrip && b.retdate
    ? `${b.date || "—"} ${b.time || ""}`.trim() + ` → Return ${b.retdate}`
    : `${b.date || "—"} ${b.time || ""}`.trim();
  const supportDisplay = `+91 ${String(supportNumber).replace(/^91/, "").replace(/(\d{5})(\d{5})/, "$1 $2")}`;

  const v2Payload = (to) => ({ messaging_product: "whatsapp", to, type: "template", template: { name: notifTemplate, language: { code: "en" }, components: [{ type: "body", parameters: [
    { type: "text", text: paymentStatus },
    { type: "text", text: String(b.id) },
    { type: "text", text: String(b.name) },
    { type: "text", text: `+91${b.phone}` },
    { type: "text", text: vehicleType },
    { type: "text", text: tripType },
    { type: "text", text: pickupLoc },
    { type: "text", text: dropLoc },
    { type: "text", text: tripTiming },
    { type: "text", text: paidAmt },
    { type: "text", text: dueAmt },
    { type: "text", text: supportDisplay }
  ]}]}});

  const legacyPayload = (to) => ({ messaging_product: "whatsapp", to, type: "template", template: { name: "oneway_notification", language: { code: "en" }, components: [{ type: "body", parameters: [
    { type: "text", text: String(b.id) },
    { type: "text", text: String(b.name) },
    { type: "text", text: `+91${b.phone}` },
    { type: "text", text: pickupLoc },
    { type: "text", text: dropLoc },
    { type: "text", text: paidAmt },
    { type: "text", text: dueAmt },
    { type: "text", text: tripTiming }
  ]}]}});

  // If the env var explicitly names the legacy template, send the correctly
  // shaped 8-param payload directly — don't waste a guaranteed-failing
  // 12-param attempt against an 8-param template first. Otherwise (v2 name,
  // or no override yet) try v2 first, with the legacy payload as a fallback
  // in case v2 isn't approved/created on Meta yet.
  const makePayloads = (to) => notifTemplate === "oneway_notification"
    ? [legacyPayload(to)]
    : [v2Payload(to), legacyPayload(to)];

  const trySend = async (to, label) => {
    for (const payload of makePayloads(to)) {
      try {
        const waRes = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const waData = await waRes.json();
        if (waRes.ok && waData?.messages?.[0]?.id) {
          console.log(`${label} notified via template — id:`, waData.messages[0].id);
          return true;
        }
        const code = waData?.error?.code;
        console.error(`${label} WA attempt failed — code:`, code, "| message:", waData?.error?.message, "| fbtrace:", waData?.error?.fbtrace_id);
        // Only retry on structure/parameter errors
        if (code && ![132000, 132001, 132018].includes(Number(code))) break;
      } catch (err) {
        console.error(`${label} WA exception:`, err.message);
        break;
      }
    }
    return false;
  };

  // Send to admin
  try {
    const ok = await trySend(adminNumber, "Admin");
    if (!ok) {
      return jsonResponse({ sent: false, reason: "upstream_error" }, 200, allowOrigin);
    }
  } catch (err) {
    console.error("Admin WA notify exception:", err.message);
    return jsonResponse({ sent: false, reason: err.message }, 200, allowOrigin);
  }

  return jsonResponse({ sent: true }, 200, allowOrigin);
}
__name(handleBookingNotify, "handleBookingNotify");

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
      console.error("Razorpay order creation failed:", JSON.stringify(rpData));
      return jsonResponse({ error: "Could not initiate payment. Please try again." }, 502, allowOrigin);
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


// ── Customer confirmation — WhatsApp message to customer after payment ────────
async function handleCustomerConfirm(request, env, allowOrigin) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);

  let body;
  try { body = await request.json(); } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin);
  }

  const b = body.booking || {};
  if (!b.id || !b.name || !b.phone) {
    return jsonResponse({ error: "Missing required booking fields" }, 400, allowOrigin);
  }

  const accessToken   = env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  const supportNumber = env.ADMIN_SUPPORT_NUMBER || env.ADMIN_WHATSAPP_NUMBER || "919355757579";

  if (!accessToken || !phoneNumberId) {
    console.warn("WhatsApp not configured — skipping customer confirmation");
    return jsonResponse({ sent: false, reason: "not_configured" }, 200, allowOrigin);
  }

  const stops = Array.isArray(b.extraCities) ? b.extraCities.filter(c => c.trim()) : [];
  const customerNumber = `91${b.phone}`;
  // Same v2 template as the admin alert, so there's only one template to
  // maintain in Meta Business Manager. Falls back to the old 8-param
  // template if WHATSAPP_NOTIFY_TEMPLATE_NAME still points at it.
  const notifTemplate  = env.WHATSAPP_NOTIFY_TEMPLATE_NAME || "oneway_notification_v2";

  // Template variables — must match oneway_notification_v2 exactly (12 params):
  // {{1}} Payment status   {{2}} Booking ID   {{3}} Name      {{4}} Phone
  // {{5}} Vehicle          {{6}} Trip type    {{7}} Pickup    {{8}} Drop
  // {{9}} Trip timing      {{10}} Paid amt    {{11}} Due amt  {{12}} Support number
  const isRoundTrip = b.tripType === "roundtrip";
  const pickupLoc   = `${b.from || "—"}${stops.length ? " → " + stops.join(" → ") : ""}`;
  const dropLoc     = isRoundTrip ? "Same as pickup (round trip)" : (b.to || "—");
  const vehicleType = b.vehicle || "—";
  const tripType    = isRoundTrip ? "Round Trip" : "One Way";
  const paidAmt     = `₹${Number(b.payAmt || 0).toLocaleString("en-IN")}`;
  const dueAmt      = `₹${Number((b.fare || 0) - (b.payAmt || 0)).toLocaleString("en-IN")}`;
  const tripTiming  = isRoundTrip && b.retdate
    ? `${b.date || "—"} ${b.time || ""}`.trim() + ` → Return ${b.retdate}`
    : `${b.date || "—"} ${b.time || ""}`.trim();
  const supportDisplay = `+91 ${String(supportNumber).replace(/^91/, "").replace(/(\d{5})(\d{5})/, "$1 $2")}`;

  const v2Payload = { messaging_product: "whatsapp", to: customerNumber, type: "template", template: { name: notifTemplate, language: { code: "en" }, components: [{ type: "body", parameters: [
    { type: "text", text: "Payment Completed" },
    { type: "text", text: String(b.id) },
    { type: "text", text: String(b.name) },
    { type: "text", text: `+91${b.phone}` },
    { type: "text", text: vehicleType },
    { type: "text", text: tripType },
    { type: "text", text: pickupLoc },
    { type: "text", text: dropLoc },
    { type: "text", text: tripTiming },
    { type: "text", text: paidAmt },
    { type: "text", text: dueAmt },
    { type: "text", text: supportDisplay }
  ]}]}};

  const legacyPayload = { messaging_product: "whatsapp", to: customerNumber, type: "template", template: { name: "oneway_notification", language: { code: "en" }, components: [{ type: "body", parameters: [
    { type: "text", text: String(b.id) },
    { type: "text", text: String(b.name) },
    { type: "text", text: `+91${b.phone}` },
    { type: "text", text: pickupLoc },
    { type: "text", text: dropLoc },
    { type: "text", text: paidAmt },
    { type: "text", text: dueAmt },
    { type: "text", text: tripTiming }
  ]}]}};

  // If the env var explicitly names the legacy template, send the correctly
  // shaped 8-param payload directly rather than guaranteeing a failed first
  // attempt against an 8-param template with 12 params.
  const payloads = notifTemplate === "oneway_notification"
    ? [legacyPayload]
    : [v2Payload, legacyPayload];

  for (const payload of payloads) {
    try {
      const waRes = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const waData = await waRes.json();
      if (waRes.ok && waData?.messages?.[0]?.id) {
        console.log("Customer notified — id:", waData.messages[0].id);
        return jsonResponse({ sent: true }, 200, allowOrigin);
      }
      const code = waData?.error?.code;
      console.error("Customer WA attempt failed — code:", code, "| message:", waData?.error?.message, "| fbtrace:", waData?.error?.fbtrace_id);
      if (code && ![132000, 132001, 132018].includes(Number(code))) break;
    } catch (err) {
      console.error("Customer WA confirm exception:", err.message);
      break;
    }
  }
  return jsonResponse({ sent: false, reason: "upstream_error" }, 200, allowOrigin);
}

// ════════════════════════════════════════════════════════════════════════════
// CRM MODULE — duties (bookings), drivers, admin/driver auth, and the
// auto-notify-on-assignment flow. Everything below is new; nothing above
// this banner (other than the two saveDutyFromBooking() call-sites and the
// routing block near the top) was touched from the original file.
// ════════════════════════════════════════════════════════════════════════════

// ── Password hashing (PBKDF2-SHA256, Web Crypto — no external deps) ─────────
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  let salt;
  if (saltHex) {
    salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  } else {
    salt = crypto.getRandomValues(new Uint8Array(16));
  }
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const hashHex = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
  const saltOutHex = [...salt].map(b => b.toString(16).padStart(2, "0")).join("");
  return { hash: hashHex, salt: saltOutHex };
}
__name(hashPassword, "hashPassword");

async function verifyPassword(password, saltHex, expectedHashHex) {
  const { hash } = await hashPassword(password, saltHex);
  // Constant-time-ish comparison
  if (hash.length !== expectedHashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ expectedHashHex.charCodeAt(i);
  return diff === 0;
}
__name(verifyPassword, "verifyPassword");

// ── Sessions ──────────────────────────────────────────────────────────────────
// Session tokens are random opaque strings stored in KV as session:<token> ->
// { role: 'admin'|'driver', id: <username or driverId>, exp: <epoch ms> }.
// Simple, fast to check, and easy to revoke (delete the KV key) on logout.
async function createSession(env, role, id) {
  const token = generateToken() + generateToken(); // 64 chars, plenty of entropy
  const record = { role, id, exp: Date.now() + SESSION_TTL_SECONDS * 1000 };
  await env.CRM_KV.put(`session:${token}`, JSON.stringify(record), { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}
__name(createSession, "createSession");

async function getSession(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;
  try {
    const raw = await env.CRM_KV.get(`session:${token}`);
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (!record.exp || record.exp < Date.now()) return null;
    return { ...record, token };
  } catch {
    return null;
  }
}
__name(getSession, "getSession");

async function requireRole(env, request, role) {
  const session = await getSession(env, request);
  if (!session) return { error: jsonResponse({ error: "Not logged in" }, 401) };
  if (role && session.role !== role) return { error: jsonResponse({ error: "Not authorized" }, 403) };
  return { session };
}
__name(requireRole, "requireRole");

// ── Index helpers — KV has no query/list-by-field, so we keep small JSON
// arrays of IDs alongside the records themselves. Fine at hundreds-to-low-
// thousands of duties/drivers; if this grows much past that, move to D1. ──
async function readIndex(env, key) {
  try {
    const raw = await env.CRM_KV.get(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
__name(readIndex, "readIndex");

async function addToIndex(env, key, id) {
  const list = await readIndex(env, key);
  if (!list.includes(id)) {
    list.unshift(id); // newest first
    await env.CRM_KV.put(key, JSON.stringify(list));
  }
}
__name(addToIndex, "addToIndex");

async function removeFromIndex(env, key, id) {
  const list = await readIndex(env, key);
  const filtered = list.filter(x => x !== id);
  if (filtered.length !== list.length) {
    await env.CRM_KV.put(key, JSON.stringify(filtered));
  }
}
__name(removeFromIndex, "removeFromIndex");

// ── Admin login ───────────────────────────────────────────────────────────────
async function handleAdminLogin(request, env, allowOrigin) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }

  const username = sanitizeString(body.username, 80).toLowerCase();
  const password = String(body.password || "");
  if (!username || !password) return jsonResponse({ error: "Username and password required" }, 400, allowOrigin);

  const raw = await env.CRM_KV.get(`admin:${username}`);
  if (!raw) return jsonResponse({ error: "Invalid username or password" }, 401, allowOrigin);

  let user;
  try {
    user = JSON.parse(raw);
  } catch (err) {
    // Don't log the raw value here — it contains the password hash/salt.
    console.error("Admin login: stored record for", username, "failed to parse:", err.message);
    return jsonResponse({ error: "Account data is corrupted. Contact support." }, 500, allowOrigin);
  }
  const ok = await verifyPassword(password, user.salt, user.hash);
  if (!ok) return jsonResponse({ error: "Invalid username or password" }, 401, allowOrigin);

  const token = await createSession(env, "admin", username);
  return jsonResponse({ token, name: user.name || username, role: "admin" }, 200, allowOrigin);
}
__name(handleAdminLogin, "handleAdminLogin");

// ── Driver login — driver logs in with phone (10 digits) + password ─────────
async function handleDriverLogin(request, env, allowOrigin) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }

  const phone = validatePhone(body.phone);
  const password = String(body.password || "");
  if (!phone || !password) return jsonResponse({ error: "Valid phone and password required" }, 400, allowOrigin);

  const raw = await env.CRM_KV.get(`driver:${phone}`);
  if (!raw) return jsonResponse({ error: "Invalid phone or password" }, 401, allowOrigin);

  let driver;
  try {
    driver = JSON.parse(raw);
  } catch (err) {
    console.error("Driver login: stored record for", phone, "failed to parse:", err.message);
    return jsonResponse({ error: "Account data is corrupted. Contact support." }, 500, allowOrigin);
  }
  if (driver.active === false) return jsonResponse({ error: "This driver account is disabled" }, 403, allowOrigin);

  const ok = await verifyPassword(password, driver.salt, driver.hash);
  if (!ok) return jsonResponse({ error: "Invalid phone or password" }, 401, allowOrigin);

  const token = await createSession(env, "driver", phone);
  return jsonResponse({ token, name: driver.name, phone, role: "driver" }, 200, allowOrigin);
}
__name(handleDriverLogin, "handleDriverLogin");

async function handleLogout(request, env, allowOrigin) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);
  const session = await getSession(env, request);
  if (session && env.CRM_KV) await env.CRM_KV.delete(`session:${session.token}`);
  return jsonResponse({ ok: true }, 200, allowOrigin);
}
__name(handleLogout, "handleLogout");

async function handleMe(request, env, allowOrigin) {
  const session = await getSession(env, request);
  if (!session) return jsonResponse({ error: "Not logged in" }, 401, allowOrigin);
  return jsonResponse({ role: session.role, id: session.id }, 200, allowOrigin);
}
__name(handleMe, "handleMe");

// ── Duties ────────────────────────────────────────────────────────────────────
// A duty record looks like:
// {
//   id, name, phone, from, to, extraCities, date, time, fare, advance,
//   vehicleType, status: 'new'|'assigned'|'ongoing'|'completed'|'cancelled',
//   driverId, driverName, driverPhone, vehicleNumber, createdAt, assignedAt
// }
async function saveDutyFromBooking(env, b) {
  const id = String(b.id);
  const existingRaw = await env.CRM_KV.get(`duty:${id}`);
  const isPaymentDone = b.type === "payment";
  // Only the post-payment call (type:"payment") reflects money actually
  // collected. The pre-payment call's b.advance is the INTENDED amount the
  // customer is about to pay — recording that as paid would make a duty
  // look paid even if the customer abandons checkout and never pays at all.
  const actuallyPaid = isPaymentDone ? Number(b.payAmt || b.advance || 0) : 0;

  if (existingRaw) {
    // Duty already exists (created by the earlier pre-payment call). Keep
    // its assignment/status state intact, but DO update the payment fields
    // once the real post-payment call comes in — otherwise a booking that's
    // genuinely paid would be stuck showing ₹0 paid forever.
    const existing = JSON.parse(existingRaw);
    if (isPaymentDone && actuallyPaid > existing.advance) {
      existing.advance = actuallyPaid;
      existing.paymentId = sanitizeString(b.paymentId || "", 60) || existing.paymentId || null;
      await env.CRM_KV.put(`duty:${id}`, JSON.stringify(existing));
    }
    return existing;
  }

  const stops = Array.isArray(b.extraCities) ? b.extraCities.filter(c => String(c || "").trim()) : [];
  const duty = {
    id,
    name: sanitizeString(b.name, 120),
    phone: validatePhone(b.phone) || sanitizeString(String(b.phone || ""), 15),
    from: sanitizeString(b.from, 200),
    to: sanitizeString(b.to, 200),
    extraCities: stops.map(c => sanitizeString(c, 200)),
    date: sanitizeString(b.date, 30),
    time: sanitizeString(b.time, 30),
    fare: Number(b.fare || 0),
    advance: actuallyPaid,
    paymentId: sanitizeString(b.paymentId || "", 60) || null,
    vehicleType: sanitizeString(b.vehicleType || b.cabType || b.vehicle || "", 60),
    tripType: b.tripType === "roundtrip" ? "roundtrip" : "oneway",
    retdate: sanitizeString(b.retdate || "", 30),
    status: "new",
    driverId: null,
    driverName: null,
    driverPhone: null,
    vehicleNumber: null,
    createdAt: Date.now(),
    assignedAt: null,
    reviewRequestSent: false,
    source: "website"
  };
  await env.CRM_KV.put(`duty:${id}`, JSON.stringify(duty));
  await addToIndex(env, "duty-index", id);
  return duty;
}
__name(saveDutyFromBooking, "saveDutyFromBooking");

// Admin manually adding a duty that didn't come through the website
// (phone booking, walk-in, etc).
async function handleDutyCreate(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }

  const phone = validatePhone(body.phone);
  const name = sanitizeString(body.name, 120);
  const from = sanitizeString(body.from, 200);
  const to = sanitizeString(body.to, 200);
  if (!phone || !name || !from || !to) {
    return jsonResponse({ error: "name, phone, from and to are required" }, 400, allowOrigin);
  }

  // NOTE: previously used Date.now().toString(36), but that collides when two
  // duties are created within the same millisecond (e.g. rapid admin clicks,
  // or concurrent requests), silently overwriting one booking with another.
  // generateToken() uses real randomness instead, so this can't happen.
  const id = "M" + generateToken().slice(0, 10).toUpperCase();
  const duty = {
    id,
    name,
    phone,
    from,
    to,
    extraCities: [],
    date: sanitizeString(body.date, 30),
    time: sanitizeString(body.time, 30),
    fare: Number(body.fare || 0),
    advance: Number(body.advance || 0),
    vehicleType: sanitizeString(body.vehicleType, 60),
    status: "new",
    driverId: null,
    driverName: null,
    driverPhone: null,
    vehicleNumber: null,
    createdAt: Date.now(),
    assignedAt: null,
    reviewRequestSent: false,
    source: "manual"
  };
  await env.CRM_KV.put(`duty:${id}`, JSON.stringify(duty));
  await addToIndex(env, "duty-index", id);
  return jsonResponse({ duty }, 200, allowOrigin);
}
__name(handleDutyCreate, "handleDutyCreate");

// List duties — admin sees all, driver sees only their own assigned duties.
async function handleDutyList(request, env, allowOrigin) {
  const auth = await requireRole(env, request, null);
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ duties: [] }, 200, allowOrigin);

  const ids = await readIndex(env, "duty-index");
  const records = await Promise.all(ids.map(id => env.CRM_KV.get(`duty:${id}`)));
  let duties = records.filter(Boolean).map(r => JSON.parse(r));

  if (auth.session.role === "driver") {
    duties = duties.filter(d => d.driverId === auth.session.id);
  }

  return jsonResponse({ duties }, 200, allowOrigin);
}
__name(handleDutyList, "handleDutyList");

// Driver/admin updates a duty's status (e.g. driver marks "ongoing" or
// "completed"; admin can cancel).
async function handleDutyStatus(request, env, allowOrigin) {
  const auth = await requireRole(env, request, null);
  if (auth.error) return auth.error;
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }

  const dutyId = String(body.dutyId || "");
  const newStatus = String(body.status || "");
  const allowedStatuses = ["new", "assigned", "ongoing", "completed", "cancelled"];
  if (!dutyId || !allowedStatuses.includes(newStatus)) {
    return jsonResponse({ error: "Valid dutyId and status required" }, 400, allowOrigin);
  }

  const raw = await env.CRM_KV.get(`duty:${dutyId}`);
  if (!raw) return jsonResponse({ error: "Duty not found" }, 404, allowOrigin);
  const duty = JSON.parse(raw);

  // A driver may only touch their own assigned duty, and only move it
  // forward (ongoing/completed) — not reassign or cancel.
  if (auth.session.role === "driver") {
    if (duty.driverId !== auth.session.id) return jsonResponse({ error: "Not your duty" }, 403, allowOrigin);
    if (!["ongoing", "completed"].includes(newStatus)) return jsonResponse({ error: "Not allowed" }, 403, allowOrigin);
  }

  const wasAlreadyCompleted = duty.status === "completed";
  duty.status = newStatus;

  // Fire a Google-review request the moment a trip is freshly marked
  // completed (not on every subsequent status write once it's already
  // completed, and not blocking the response if WhatsApp is slow/down).
  let reviewRequestSent = duty.reviewRequestSent || false;
  if (newStatus === "completed" && !wasAlreadyCompleted && !duty.reviewRequestSent) {
    reviewRequestSent = await sendReviewRequest(env, duty).catch(err => {
      console.error("Review request send failed:", err.message);
      return false;
    });
    duty.reviewRequestSent = reviewRequestSent;
  }

  await env.CRM_KV.put(`duty:${dutyId}`, JSON.stringify(duty));
  return jsonResponse({ duty, reviewRequestSent }, 200, allowOrigin);
}
__name(handleDutyStatus, "handleDutyStatus");

// ── Send a Google-review request to the customer right after their trip is
// marked completed. Uses a dedicated template since this is a distinct
// message (post-trip, asking for a review) from the payment/assignment
// alerts. GOOGLE_REVIEW_LINK defaults to a placeholder until the real Google
// Business review link is set as a Worker secret. ───────────────────────────
async function sendReviewRequest(env, duty) {
  const accessToken   = env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId || !duty.phone) return false;

  const reviewTemplate = env.WHATSAPP_REVIEW_REQUEST_TEMPLATE_NAME || "oneway_review_request";
  const reviewLink = env.GOOGLE_REVIEW_LINK || "https://g.page/r/REPLACE_WITH_REAL_LINK/review";
  const customerNumber = `91${duty.phone}`;

  const payload = {
    messaging_product: "whatsapp", to: customerNumber, type: "template",
    template: { name: reviewTemplate, language: { code: "en" }, components: [{ type: "body", parameters: [
      { type: "text", text: String(duty.name || "there") },
      { type: "text", text: String(duty.id) },
      { type: "text", text: reviewLink }
    ]}]}
  };

  try {
    const waRes = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const waData = await waRes.json();
    if (waRes.ok && waData?.messages?.[0]?.id) {
      console.log("Review request sent — id:", waData.messages[0].id);
      return true;
    }
    console.error("Review request WA failed — code:", waData?.error?.code, "| message:", waData?.error?.message);
    return false;
  } catch (err) {
    console.error("Review request WA exception:", err.message);
    return false;
  }
}
__name(sendReviewRequest, "sendReviewRequest");

// ── THE key feature: assign a driver+vehicle to a duty, then fire all 3
// WhatsApp notifications (customer, driver, admin) in one shot. ────────────
async function handleDutyAssign(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }

  const dutyId = String(body.dutyId || "");
  const driverId = validatePhone(body.driverId || body.driverPhone);
  const vehicleNumber = sanitizeString(body.vehicleNumber, 30);
  if (!dutyId || !driverId) return jsonResponse({ error: "dutyId and driverId (driver phone) are required" }, 400, allowOrigin);

  const dutyRaw = await env.CRM_KV.get(`duty:${dutyId}`);
  if (!dutyRaw) return jsonResponse({ error: "Duty not found" }, 404, allowOrigin);
  const duty = JSON.parse(dutyRaw);

  const driverRaw = await env.CRM_KV.get(`driver:${driverId}`);
  if (!driverRaw) return jsonResponse({ error: "Driver not found" }, 404, allowOrigin);
  const driver = JSON.parse(driverRaw);

  duty.driverId = driverId;
  duty.driverName = driver.name;
  duty.driverPhone = driverId;
  duty.vehicleNumber = vehicleNumber || driver.vehicleNumber || "";
  duty.vehicleType = duty.vehicleType || driver.vehicleType || "";
  duty.status = "assigned";
  duty.assignedAt = Date.now();
  await env.CRM_KV.put(`duty:${dutyId}`, JSON.stringify(duty));

  // Fire all 3 notifications. Each is independent and best-effort — if one
  // WhatsApp send fails (e.g. template not yet approved), the assignment
  // itself still goes through; we just report which sends succeeded.
  const results = await sendAssignmentNotifications(env, duty, driver);

  return jsonResponse({ duty, notifications: results }, 200, allowOrigin);
}
__name(handleDutyAssign, "handleDutyAssign");

async function sendAssignmentNotifications(env, duty, driver) {
  const accessToken   = env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  const adminNumber    = env.ADMIN_WHATSAPP_NUMBER || "919355757579";
  const driverTemplate  = env.WHATSAPP_DRIVER_ASSIGN_TEMPLATE_NAME   || "oneway_driver_assignment";
  const customerTemplate= env.WHATSAPP_CUSTOMER_ASSIGN_TEMPLATE_NAME || "oneway_assignment_confirmed";
  // Deliberately a SEPARATE template/env var from WHATSAPP_NOTIFY_TEMPLATE_NAME
  // (the payment-status alert, now 12 params as of oneway_notification_v2).
  // This message is about driver assignment, not payment, and is still an
  // 8-param template — pointing both concerns at the same env var would break
  // whichever one didn't match the live template's param count.
  const adminTemplate   = env.WHATSAPP_ASSIGN_NOTIFY_TEMPLATE_NAME || "oneway_notification";

  const results = { driver: false, customer: false, admin: false };
  if (!accessToken || !phoneNumberId) {
    console.warn("WhatsApp not configured — skipping assignment notifications");
    return results;
  }

  const stops = Array.isArray(duty.extraCities) ? duty.extraCities.filter(c => c) : [];
  const pickup = `${duty.from || "—"}${stops.length ? " → " + stops.join(" → ") : ""}`;
  const tripTiming = `${duty.date || "—"} ${duty.time || ""}`.trim();
  const vehicleLabel = [duty.vehicleType, duty.vehicleNumber].filter(Boolean).join(" · ") || "—";
  const fareLabel = `₹${Number(duty.fare || 0).toLocaleString("en-IN")}`;

  const send = async (to, templateName, parameters, label) => {
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: { name: templateName, language: { code: "en" }, components: [{ type: "body", parameters }] }
    };
    try {
      const waRes = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const waData = await waRes.json();
      if (waRes.ok && waData?.messages?.[0]?.id) {
        console.log(`${label} assignment notify sent — id:`, waData.messages[0].id);
        return true;
      }
      console.error(`${label} assignment notify failed — code:`, waData?.error?.code, "| message:", waData?.error?.message);
      return false;
    } catch (err) {
      console.error(`${label} assignment notify exception:`, err.message);
      return false;
    }
  };

  // 1) Driver — gets full duty-slip style message
  results.driver = await send(`91${duty.driverPhone}`, driverTemplate, [
    { type: "text", text: String(duty.id) },
    { type: "text", text: String(duty.name) },
    { type: "text", text: `+91${duty.phone}` },
    { type: "text", text: pickup },
    { type: "text", text: duty.to || "—" },
    { type: "text", text: tripTiming },
    { type: "text", text: vehicleLabel },
    { type: "text", text: fareLabel }
  ], "Driver");

  // 2) Customer — gets driver + vehicle confirmation
  results.customer = await send(`91${duty.phone}`, customerTemplate, [
    { type: "text", text: String(duty.id) },
    { type: "text", text: String(duty.driverName) },
    { type: "text", text: `+91${duty.driverPhone}` },
    { type: "text", text: vehicleLabel },
    { type: "text", text: pickup },
    { type: "text", text: tripTiming }
  ], "Customer");

  // 3) Admin — internal heads-up reusing the existing notification template
  results.admin = await send(adminNumber, adminTemplate, [
    { type: "text", text: String(duty.id) },
    { type: "text", text: `Assigned: ${duty.driverName}` },
    { type: "text", text: `+91${duty.driverPhone}` },
    { type: "text", text: pickup },
    { type: "text", text: duty.to || "—" },
    { type: "text", text: vehicleLabel },
    { type: "text", text: fareLabel },
    { type: "text", text: tripTiming }
  ], "Admin");

  return results;
}
__name(sendAssignmentNotifications, "sendAssignmentNotifications");

// ── Drivers ───────────────────────────────────────────────────────────────────
async function handleDriverCreate(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }

  const phone = validatePhone(body.phone);
  const name = sanitizeString(body.name, 120);
  const password = String(body.password || "");
  if (!phone || !name || !password || password.length < 6) {
    return jsonResponse({ error: "name, valid 10-digit phone, and a password of 6+ characters are required" }, 400, allowOrigin);
  }

  const existing = await env.CRM_KV.get(`driver:${phone}`);
  if (existing) return jsonResponse({ error: "A driver with this phone number already exists" }, 409, allowOrigin);

  const { hash, salt } = await hashPassword(password);
  const driver = {
    id: phone,
    phone,
    name,
    vehicleType: sanitizeString(body.vehicleType, 60),
    vehicleNumber: sanitizeString(body.vehicleNumber, 30),
    active: true,
    hash,
    salt,
    createdAt: Date.now()
  };
  await env.CRM_KV.put(`driver:${phone}`, JSON.stringify(driver));
  await addToIndex(env, "driver-index", phone);

  const { hash: _h, salt: _s, ...safeDriver } = driver;
  return jsonResponse({ driver: safeDriver }, 200, allowOrigin);
}
__name(handleDriverCreate, "handleDriverCreate");

async function handleDriverList(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ drivers: [] }, 200, allowOrigin);

  const ids = await readIndex(env, "driver-index");
  const records = await Promise.all(ids.map(id => env.CRM_KV.get(`driver:${id}`)));
  const drivers = records.filter(Boolean).map(r => {
    const { hash, salt, ...safe } = JSON.parse(r);
    return safe;
  });

  return jsonResponse({ drivers }, 200, allowOrigin);
}
__name(handleDriverList, "handleDriverList");

// Admin edits a driver's details, optionally resets password, or
// activates/deactivates them (disabled drivers can't log in or be assigned).
async function handleDriverUpdate(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }

  const phone = validatePhone(body.phone || body.id);
  if (!phone) return jsonResponse({ error: "Valid driver phone required" }, 400, allowOrigin);

  const raw = await env.CRM_KV.get(`driver:${phone}`);
  if (!raw) return jsonResponse({ error: "Driver not found" }, 404, allowOrigin);
  const driver = JSON.parse(raw);

  if (body.name !== undefined) driver.name = sanitizeString(body.name, 120);
  if (body.vehicleType !== undefined) driver.vehicleType = sanitizeString(body.vehicleType, 60);
  if (body.vehicleNumber !== undefined) driver.vehicleNumber = sanitizeString(body.vehicleNumber, 30);
  if (body.active !== undefined) driver.active = !!body.active;
  if (body.password) {
    if (String(body.password).length < 6) return jsonResponse({ error: "Password must be 6+ characters" }, 400, allowOrigin);
    const { hash, salt } = await hashPassword(String(body.password));
    driver.hash = hash;
    driver.salt = salt;
  }

  await env.CRM_KV.put(`driver:${phone}`, JSON.stringify(driver));
  const { hash: _h, salt: _s, ...safeDriver } = driver;
  return jsonResponse({ driver: safeDriver }, 200, allowOrigin);
}
__name(handleDriverUpdate, "handleDriverUpdate");

// ── Admin: Customers (computed view, derived from duty records) ─────────────
// No separate customer storage — a "customer" is just the set of distinct
// phone numbers seen across duties, with trip count and total spend rolled
// up. Keeps a single source of truth (the duty records) instead of two
// copies of the same data that could drift out of sync.
async function handleCustomersList(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  const ids = await readIndex(env, "duty-index");
  const records = await Promise.all(ids.map(id => env.CRM_KV.get(`duty:${id}`)));
  const duties = records.filter(Boolean).map(r => JSON.parse(r));

  const byPhone = new Map();
  for (const d of duties) {
    if (!d.phone) continue;
    const existing = byPhone.get(d.phone) || {
      phone: d.phone, name: d.name, trips: 0, spent: 0, firstSeen: d.createdAt, lastSeen: d.createdAt
    };
    existing.trips += 1;
    existing.spent += Number(d.advance || 0);
    // Only adopt this duty's name if it's genuinely the most recent one seen
    // so far — duty-index order isn't a reliable proxy for "most recent"
    // once any one of several KV reads races or the index gets rebuilt.
    if (d.name && d.createdAt >= existing.lastSeen) existing.name = d.name;
    if (d.createdAt < existing.firstSeen) existing.firstSeen = d.createdAt;
    if (d.createdAt > existing.lastSeen) existing.lastSeen = d.createdAt;
    byPhone.set(d.phone, existing);
  }

  const customers = [...byPhone.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  return jsonResponse({ customers }, 200, allowOrigin);
}
__name(handleCustomersList, "handleCustomersList");

// ── Admin: Payments (computed view, derived from duty records) ──────────────
async function handlePaymentsList(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  const ids = await readIndex(env, "duty-index");
  const records = await Promise.all(ids.map(id => env.CRM_KV.get(`duty:${id}`)));
  const duties = records.filter(Boolean).map(r => JSON.parse(r));

  const payments = duties
    .filter(d => Number(d.advance || 0) > 0)
    .map(d => ({
      bookingId: d.id,
      customerName: d.name,
      customerPhone: d.phone,
      amount: Number(d.advance || 0),
      fare: Number(d.fare || 0),
      due: Math.max(0, Number(d.fare || 0) - Number(d.advance || 0)),
      status: d.status === "cancelled" ? "refund_pending" : "paid",
      date: d.createdAt
    }))
    .sort((a, b) => b.date - a.date);

  return jsonResponse({ payments }, 200, allowOrigin);
}
__name(handlePaymentsList, "handlePaymentsList");

// ── Admin: Vehicles (simple reference list — name, capacity, icon) ──────────
async function handleVehicleCreate(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }

  const name = sanitizeString(body.name, 60);
  if (!name) return jsonResponse({ error: "Vehicle name is required" }, 400, allowOrigin);

  const id = "veh_" + generateToken().slice(0, 12);
  const vehicle = {
    id,
    name,
    capacity: sanitizeString(body.capacity, 20) || "—",
    icon: sanitizeString(body.icon, 8) || "🚗",
    notes: sanitizeString(body.notes, 200) || "",
    createdAt: Date.now()
  };
  await env.CRM_KV.put(`vehicle:${id}`, JSON.stringify(vehicle));
  await addToIndex(env, "vehicle-index", id);
  return jsonResponse({ vehicle }, 200, allowOrigin);
}
__name(handleVehicleCreate, "handleVehicleCreate");

async function handleVehicleList(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  const ids = await readIndex(env, "vehicle-index");
  const records = await Promise.all(ids.map(id => env.CRM_KV.get(`vehicle:${id}`)));
  const vehicles = records.filter(Boolean).map(r => JSON.parse(r));
  return jsonResponse({ vehicles }, 200, allowOrigin);
}
__name(handleVehicleList, "handleVehicleList");

async function handleVehicleDelete(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }
  const id = sanitizeString(body.id, 40);
  if (!id) return jsonResponse({ error: "Vehicle id is required" }, 400, allowOrigin);

  await env.CRM_KV.delete(`vehicle:${id}`);
  await removeFromIndex(env, "vehicle-index", id);
  return jsonResponse({ deleted: true }, 200, allowOrigin);
}
__name(handleVehicleDelete, "handleVehicleDelete");

// ── Admin: Routes (simple reference list — from/to/distance, NOT wired to
// live fare calculation on the public booking form) ──────────────────────────
async function handleRouteCreate(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }

  const from = sanitizeString(body.from, 100);
  const to = sanitizeString(body.to, 100);
  if (!from || !to) return jsonResponse({ error: "Both from and to cities are required" }, 400, allowOrigin);

  const id = "route_" + generateToken().slice(0, 12);
  const route = {
    id,
    from,
    to,
    distanceKm: Number(body.distanceKm) > 0 ? Number(body.distanceKm) : null,
    notes: sanitizeString(body.notes, 200) || "",
    createdAt: Date.now()
  };
  await env.CRM_KV.put(`route:${id}`, JSON.stringify(route));
  await addToIndex(env, "route-index", id);
  return jsonResponse({ route }, 200, allowOrigin);
}
__name(handleRouteCreate, "handleRouteCreate");

async function handleRouteList(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  const ids = await readIndex(env, "route-index");
  const records = await Promise.all(ids.map(id => env.CRM_KV.get(`route:${id}`)));
  const routes = records.filter(Boolean).map(r => JSON.parse(r));
  return jsonResponse({ routes }, 200, allowOrigin);
}
__name(handleRouteList, "handleRouteList");

async function handleRouteDelete(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }
  const id = sanitizeString(body.id, 40);
  if (!id) return jsonResponse({ error: "Route id is required" }, 400, allowOrigin);

  await env.CRM_KV.delete(`route:${id}`);
  await removeFromIndex(env, "route-index", id);
  return jsonResponse({ deleted: true }, 200, allowOrigin);
}
__name(handleRouteDelete, "handleRouteDelete");

// ── Admin: Coupons (stored + manageable — NOT yet validated at checkout;
// wiring this into the live payment flow is a separate follow-up task) ───────
async function handleCouponCreate(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }

  const code = sanitizeString(body.code, 30).toUpperCase().replace(/\s+/g, "");
  if (!code) return jsonResponse({ error: "Coupon code is required" }, 400, allowOrigin);
  const discountPercent = Number(body.discountPercent);
  if (!discountPercent || discountPercent <= 0 || discountPercent > 100) {
    return jsonResponse({ error: "discountPercent must be between 1 and 100" }, 400, allowOrigin);
  }

  const existing = await env.CRM_KV.get(`coupon:${code}`);
  if (existing) return jsonResponse({ error: "A coupon with this code already exists" }, 409, allowOrigin);

  const coupon = {
    code,
    discountPercent,
    expiresAt: sanitizeString(body.expiresAt, 30) || null,
    active: true,
    notes: sanitizeString(body.notes, 200) || "",
    createdAt: Date.now()
  };
  await env.CRM_KV.put(`coupon:${code}`, JSON.stringify(coupon));
  await addToIndex(env, "coupon-index", code);
  return jsonResponse({ coupon }, 200, allowOrigin);
}
__name(handleCouponCreate, "handleCouponCreate");

async function handleCouponList(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  const codes = await readIndex(env, "coupon-index");
  const records = await Promise.all(codes.map(c => env.CRM_KV.get(`coupon:${c}`)));
  const coupons = records.filter(Boolean).map(r => JSON.parse(r));
  return jsonResponse({ coupons }, 200, allowOrigin);
}
__name(handleCouponList, "handleCouponList");

async function handleCouponUpdate(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }
  const code = sanitizeString(body.code, 30).toUpperCase();
  if (!code) return jsonResponse({ error: "Coupon code is required" }, 400, allowOrigin);

  const raw = await env.CRM_KV.get(`coupon:${code}`);
  if (!raw) return jsonResponse({ error: "Coupon not found" }, 404, allowOrigin);

  let coupon;
  try { coupon = JSON.parse(raw); }
  catch (err) {
    console.error("Coupon update: stored record for", code, "failed to parse:", err.message);
    return jsonResponse({ error: "Coupon data is corrupted. Contact support." }, 500, allowOrigin);
  }

  if (typeof body.active === "boolean") coupon.active = body.active;
  if (Number(body.discountPercent) > 0 && Number(body.discountPercent) <= 100) coupon.discountPercent = Number(body.discountPercent);
  if (body.expiresAt !== undefined) coupon.expiresAt = sanitizeString(body.expiresAt, 30) || null;

  await env.CRM_KV.put(`coupon:${code}`, JSON.stringify(coupon));
  return jsonResponse({ coupon }, 200, allowOrigin);
}
__name(handleCouponUpdate, "handleCouponUpdate");

async function handleCouponDelete(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }
  const code = sanitizeString(body.code, 30).toUpperCase();
  if (!code) return jsonResponse({ error: "Coupon code is required" }, 400, allowOrigin);

  await env.CRM_KV.delete(`coupon:${code}`);
  await removeFromIndex(env, "coupon-index", code);
  return jsonResponse({ deleted: true }, 200, allowOrigin);
}
__name(handleCouponDelete, "handleCouponDelete");

// ── Admin: Refunds (manual admin-logged refund tracking — there is no
// customer-facing "request a refund" flow yet; admin logs these directly
// after handling a refund conversation with the customer some other way) ────
async function handleRefundCreate(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }

  const bookingId = sanitizeString(body.bookingId, 40);
  const amount = Number(body.amount);
  if (!bookingId || !amount || amount <= 0) {
    return jsonResponse({ error: "bookingId and a positive amount are required" }, 400, allowOrigin);
  }

  const id = "refund_" + generateToken().slice(0, 12);
  const refund = {
    id,
    bookingId,
    customerName: sanitizeString(body.customerName, 120) || "",
    customerPhone: validatePhone(body.customerPhone) || "",
    amount,
    reason: sanitizeString(body.reason, 300) || "",
    status: "pending",
    createdAt: Date.now(),
    resolvedAt: null
  };
  await env.CRM_KV.put(`refund:${id}`, JSON.stringify(refund));
  await addToIndex(env, "refund-index", id);
  return jsonResponse({ refund }, 200, allowOrigin);
}
__name(handleRefundCreate, "handleRefundCreate");

async function handleRefundList(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  const ids = await readIndex(env, "refund-index");
  const records = await Promise.all(ids.map(id => env.CRM_KV.get(`refund:${id}`)));
  const refunds = records.filter(Boolean).map(r => JSON.parse(r)).sort((a, b) => b.createdAt - a.createdAt);
  return jsonResponse({ refunds }, 200, allowOrigin);
}
__name(handleRefundList, "handleRefundList");

async function handleRefundUpdate(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }
  const id = sanitizeString(body.id, 40);
  if (!id) return jsonResponse({ error: "Refund id is required" }, 400, allowOrigin);
  if (!["pending", "processed", "rejected"].includes(body.status)) {
    return jsonResponse({ error: "status must be pending, processed, or rejected" }, 400, allowOrigin);
  }

  const raw = await env.CRM_KV.get(`refund:${id}`);
  if (!raw) return jsonResponse({ error: "Refund not found" }, 404, allowOrigin);

  let refund;
  try { refund = JSON.parse(raw); }
  catch (err) {
    console.error("Refund update: stored record for", id, "failed to parse:", err.message);
    return jsonResponse({ error: "Refund data is corrupted. Contact support." }, 500, allowOrigin);
  }

  refund.status = body.status;
  refund.resolvedAt = body.status === "pending" ? null : Date.now();
  await env.CRM_KV.put(`refund:${id}`, JSON.stringify(refund));
  return jsonResponse({ refund }, 200, allowOrigin);
}
__name(handleRefundUpdate, "handleRefundUpdate");

// ── Admin: Pricing settings (persisted rate table — saved/loaded for real,
// but NOT yet wired into the live public booking-form fare calculation.
// Wiring it in is a separate follow-up since it touches the customer-facing
// fare logic in index.html/main.js.) ──────────────────────────────────────────
async function handlePricingSettings(request, env, allowOrigin) {
  if (request.method === "GET") {
    const auth = await requireRole(env, request, "admin");
    if (auth.error) return auth.error;
    if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

    const raw = await env.CRM_KV.get("settings:pricing");
    if (!raw) return jsonResponse({ pricing: null }, 200, allowOrigin);
    try {
      return jsonResponse({ pricing: JSON.parse(raw) }, 200, allowOrigin);
    } catch (err) {
      console.error("Pricing settings: stored record failed to parse:", err.message);
      return jsonResponse({ error: "Pricing data is corrupted. Contact support." }, 500, allowOrigin);
    }
  }

  if (request.method === "POST") {
    const auth = await requireRole(env, request, "admin");
    if (auth.error) return auth.error;
    if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }

    const sanitizeRates = (rates) => {
      const out = {};
      if (!rates || typeof rates !== "object") return out;
      for (const [vehicle, rate] of Object.entries(rates)) {
        const key = sanitizeString(vehicle, 40);
        const num = Number(rate);
        if (key && num > 0) out[key] = num;
      }
      return out;
    };

    const pricing = {
      oneWay: sanitizeRates(body.oneWay),
      roundTrip: sanitizeRates(body.roundTrip),
      updatedAt: Date.now()
    };
    await env.CRM_KV.put("settings:pricing", JSON.stringify(pricing));
    return jsonResponse({ pricing }, 200, allowOrigin);
  }

  return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);
}
__name(handlePricingSettings, "handlePricingSettings");

// ── Admin: GST summary (basic report derived from existing duty records —
// totals/counts only, NOT a GSTR-1-compliant filing export. Building that
// would need per-booking tax-rate fields that don't currently exist.) ────────
async function handleGstSummary(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  const ids = await readIndex(env, "duty-index");
  const records = await Promise.all(ids.map(id => env.CRM_KV.get(`duty:${id}`)));
  const duties = records.filter(Boolean).map(r => JSON.parse(r));

  const totalCollected = duties.reduce((sum, d) => sum + Number(d.advance || 0), 0);
  const totalFareValue = duties.reduce((sum, d) => sum + Number(d.fare || 0), 0);
  const totalPending = totalFareValue - totalCollected;
  const tripCount = duties.length;

  // Monthly breakdown for a basic report view
  const byMonth = new Map();
  for (const d of duties) {
    const month = new Date(d.createdAt).toISOString().slice(0, 7); // YYYY-MM
    const existing = byMonth.get(month) || { month, trips: 0, collected: 0 };
    existing.trips += 1;
    existing.collected += Number(d.advance || 0);
    byMonth.set(month, existing);
  }
  const monthly = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));

  return jsonResponse({
    summary: { totalCollected, totalFareValue, totalPending, tripCount },
    monthly,
    note: "This is a basic summary derived from booking records, not a GSTR-1-compliant filing export."
  }, 200, allowOrigin);
}
__name(handleGstSummary, "handleGstSummary");

// ── Admin: Dashboard stats (top stat cards — real numbers, derived from
// duty/driver records). "Customer Rating" has no real data source anywhere
// in this system (no review/star-rating storage exists), so it's replaced
// with a count of Google-review requests actually sent after completed
// trips, rather than showing a fabricated average. ──────────────────────────
async function handleDashboardStats(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  const dutyIds = await readIndex(env, "duty-index");
  const dutyRecords = await Promise.all(dutyIds.map(id => env.CRM_KV.get(`duty:${id}`)));
  const duties = dutyRecords.filter(Boolean).map(r => JSON.parse(r));

  const driverIds = await readIndex(env, "driver-index");
  const driverRecords = await Promise.all(driverIds.map(id => env.CRM_KV.get(`driver:${id}`)));
  const drivers = driverRecords.filter(Boolean).map(r => JSON.parse(r));

  const now = new Date();
  const thisMonthKey = now.toISOString().slice(0, 7);
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthKey = lastMonthDate.toISOString().slice(0, 7);

  const monthKeyOf = (ts) => new Date(ts).toISOString().slice(0, 7);
  const thisMonthDuties = duties.filter(d => monthKeyOf(d.createdAt) === thisMonthKey);
  const lastMonthDuties = duties.filter(d => monthKeyOf(d.createdAt) === lastMonthKey);

  const revenueThisMonth = thisMonthDuties.reduce((s, d) => s + Number(d.advance || 0), 0);
  const revenueLastMonth = lastMonthDuties.reduce((s, d) => s + Number(d.advance || 0), 0);
  const bookingsPctChange = lastMonthDuties.length > 0
    ? Math.round(((thisMonthDuties.length - lastMonthDuties.length) / lastMonthDuties.length) * 100)
    : null;
  const revenuePctChange = revenueLastMonth > 0
    ? Math.round(((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100)
    : null;

  const activeDrivers = drivers.filter(d => d.active !== false).length;
  const newDriversThisWeek = drivers.filter(d => d.createdAt && (now.getTime() - d.createdAt) < 7 * 24 * 60 * 60 * 1000).length;

  const reviewRequestsSent = duties.filter(d => d.reviewRequestSent).length;
  const completedTrips = duties.filter(d => d.status === "completed").length;

  return jsonResponse({
    totalBookings: duties.length,
    bookingsPctChange,
    revenueThisMonth,
    revenuePctChange,
    activeDrivers,
    newDriversThisWeek,
    reviewRequestsSent,
    completedTrips
  }, 200, allowOrigin);
}
__name(handleDashboardStats, "handleDashboardStats");

// ── Admin: Analytics (monthly trend + vehicle-type distribution, derived
// from duty records). ────────────────────────────────────────────────────────
async function handleAnalytics(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  const ids = await readIndex(env, "duty-index");
  const records = await Promise.all(ids.map(id => env.CRM_KV.get(`duty:${id}`)));
  const duties = records.filter(Boolean).map(r => JSON.parse(r));

  // Last 6 months of booking counts, oldest to newest, including months
  // with zero bookings so the chart doesn't silently skip gaps.
  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: d.toISOString().slice(0, 7), label: d.toLocaleDateString("en-IN", { month: "short" }) });
  }
  const countByMonth = new Map(months.map(m => [m.key, 0]));
  for (const d of duties) {
    const key = new Date(d.createdAt).toISOString().slice(0, 7);
    if (countByMonth.has(key)) countByMonth.set(key, countByMonth.get(key) + 1);
  }
  const monthlyBookings = months.map(m => ({ month: m.label, count: countByMonth.get(m.key) }));

  // Distribution by vehicle type, across all duties that have one set.
  const vehicleCounts = new Map();
  for (const d of duties) {
    const v = (d.vehicleType || "Unspecified").trim() || "Unspecified";
    vehicleCounts.set(v, (vehicleCounts.get(v) || 0) + 1);
  }
  const totalWithVehicle = duties.length;
  const vehicleDistribution = [...vehicleCounts.entries()]
    .map(([name, count]) => ({ name, count, percent: totalWithVehicle ? Math.round((count / totalWithVehicle) * 100) : 0 }))
    .sort((a, b) => b.count - a.count);

  return jsonResponse({ monthlyBookings, vehicleDistribution, totalBookings: duties.length }, 200, allowOrigin);
}
__name(handleAnalytics, "handleAnalytics");

function jsonResponse(data, status = 200, allowOrigin = null) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
  if (allowOrigin) headers["Access-Control-Allow-Origin"] = allowOrigin;
  return new Response(JSON.stringify(data), { status, headers });
}
__name(jsonResponse, "jsonResponse");

function corsPreflight(allowOrigin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
  if (allowOrigin) headers["Access-Control-Allow-Origin"] = allowOrigin;
  return new Response(null, { status: 204, headers });
}
__name(corsPreflight, "corsPreflight");

export {
  worker_default as default
};
