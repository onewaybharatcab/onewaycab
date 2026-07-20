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

// Normalise any Indian phone number to a WhatsApp-ready E.164 string (91XXXXXXXXXX).
// Rules:
//   - Strip all non-digits first
//   - If result is 10 digits → prepend 91
//   - If result is 12 digits starting with 91 → use as-is
//   - Anything else → return null (caller should abort the WA send)
function toWaNum(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  return null; // invalid — do not send
}

// Returns the bare 10-digit local number, with no "91" or "+91" prefix.
// Use this (not a manually-prefixed "+91...") when filling a WhatsApp
// template parameter whose template text already renders "+91 {{n}}" as
// static text — prefixing here too was producing a doubled "+91+91..."
// in the New Booking Alert / assignment messages.
function localPhoneDigits(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return (digits.length === 12 && digits.startsWith("91")) ? digits.slice(2) : digits;
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
    if (url.pathname.includes("auth/customer-login")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "customer-login", () => handleCustomerLogin(request, env, allowOrigin), allowOrigin, LOGIN_RATE_LIMIT_MAX))
    }

    // ── Customer: own bookings ───────────────────────────────────────────────
    if (url.pathname.includes("customer/bookings")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "customer-bookings", () => handleCustomerBookings(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("customer/invoice")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "customer-invoice", () => handleCustomerInvoice(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("customer/wallet")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "customer-wallet", () => handleCustomerWallet(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("customer/routes")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "customer-routes", () => handleCustomerRoutes(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("customer/referral")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "customer-referral", () => handleCustomerReferral(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("customer/profile")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "customer-profile", () => handleCustomerProfile(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("customer/ticket-create")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "customer-ticket-create", () => handleCustomerTicketCreate(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("customer/tickets")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "customer-tickets", () => handleCustomerTicketList(request, env, allowOrigin), allowOrigin))
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
    if (url.pathname.includes("admin/tickets")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "admin-tickets", () => handleAdminTicketList(request, env, allowOrigin), allowOrigin))
    }
    if (url.pathname.includes("admin/ticket-update")) {
      return addSecurityHeaders(await withRateLimit(request, env, ctx, "admin-ticket-update", () => handleAdminTicketUpdate(request, env, allowOrigin), allowOrigin))
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

  // ── Trust gate ──────────────────────────────────────────────────────────
  // This endpoint has no login (it's called by anonymous site visitors), so
  // it must not take the booking's contents on faith. Two things are now
  // required before we'll persist a duty or fire a "your booking" WhatsApp
  // message:
  //   1. verifyToken — proves whoever is calling actually completed OTP
  //      verification for this exact phone number (set by handleVerifyOtp).
  //   2. payment_token — ONLY for type:"payment" calls. Proves a real,
  //      signature-verified Razorpay payment exists for this booking (set
  //      by handleVerifyPayment). Without this, anyone could POST
  //      type:"payment" with a made-up payAmt and trigger a false
  //      "Payment Completed" message to the admin and the customer.
  const claimedPhone = validatePhone(b.phone);
  if (!claimedPhone) {
    return jsonResponse({ error: "Invalid phone number" }, 400, allowOrigin);
  }
  if (env.RATE_LIMIT_KV) {
    try {
      const storedToken = await env.RATE_LIMIT_KV.get(`verified:${claimedPhone}`);
      if (!storedToken || storedToken !== String(body.verifyToken || "")) {
        return jsonResponse({ error: "Phone number not verified. Please verify via OTP first." }, 403, allowOrigin);
      }
    } catch (err) {
      console.error("verifyToken check failed:", err.message);
      return jsonResponse({ error: "Could not verify request. Please try again." }, 500, allowOrigin);
    }
  } else {
    console.error("RATE_LIMIT_KV not bound — cannot enforce verifyToken, rejecting");
    return jsonResponse({ error: "Service temporarily unavailable" }, 500, allowOrigin);
  }

  const isPaymentDone = b.type === "payment";
  let pinnedPaidAmount = 0;
  if (isPaymentDone) {
    if (!env.RATE_LIMIT_KV) {
      return jsonResponse({ error: "Service temporarily unavailable" }, 500, allowOrigin);
    }
    try {
      const raw = await env.RATE_LIMIT_KV.get(`payconfirm:${b.id}`);
      const confirm = raw ? JSON.parse(raw) : null;
      if (!confirm || confirm.token !== String(b.paymentToken || body.paymentToken || "")) {
        console.warn("handleBookingNotify: missing/invalid payment_token for booking", b.id);
        return jsonResponse({ error: "Payment could not be confirmed for this booking." }, 403, allowOrigin);
      }
      pinnedPaidAmount = Number(confirm.amountRupees) || 0;
    } catch (err) {
      console.error("payconfirm check failed:", err.message);
      return jsonResponse({ error: "Could not verify payment. Please try again." }, 500, allowOrigin);
    }
  }

  // Persist the duty so it shows up in the admin panel for assignment.
  // This is best-effort — a KV hiccup here should never block the WhatsApp
  // alert from going out, since that's the part the business depends on most.
  if (env.CRM_KV) {
    try { await saveDutyFromBooking(env, b, pinnedPaidAmount); }
    catch (err) { console.error("Duty persist failed:", err.message); }
  }

  // Referral bonus check — only meaningful once a real payment has landed,
  // and only does anything if this turns out to be the customer's first
  // ever paid booking (see maybeCreditReferralBonus for the guard logic).
  // Never blocks the WhatsApp notification below if it fails.
  if (isPaymentDone && env.CRM_KV) {
    try { await maybeCreditReferralBonus(env, claimedPhone, b.id); }
    catch (err) { console.error("Referral bonus check failed:", err.message); }
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
  const paymentStatus = isPaymentDone ? "Payment Completed" : "Payment Pending";
  const isRoundTrip= b.tripType === "roundtrip";
  const pickupLoc  = `${b.from || "—"}${stops.length ? " → " + stops.join(" → ") : ""}`;
  const dropLoc    = isRoundTrip ? "Same as pickup (round trip)" : (b.to || "—");
  const vehicleType= b.vehicle || "—";
  const tripType   = isRoundTrip ? "Round Trip" : "One Way";
  // Before payment actually completes, nothing has been paid yet — b.advance
  // at that point is the INTENDED amount the customer is about to pay, not
  // money already received, so it must not be shown as "Paid". Only the
  // post-payment call (type:"payment") reflects money actually collected,
  // and now uses pinnedPaidAmount (from handleVerifyPayment's KV record)
  // rather than the client-supplied payAmt, which can no longer be spoofed.
  const actuallyPaid = isPaymentDone ? pinnedPaidAmount : 0;
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
    { type: "text", text: localPhoneDigits(b.phone) },
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
    { type: "text", text: localPhoneDigits(b.phone) },
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

  // Send to admin first (required), then also to customer (best-effort)
  let adminOk = false;
  try {
    adminOk = await trySend(adminNumber, "Admin");
    if (!adminOk) {
      console.warn("Admin WA notify failed — still attempting customer notify");
    }
  } catch (err) {
    console.error("Admin WA notify exception:", err.message);
  }

  // Customer booking confirmation — send same template to customer number
  const customerNumber = toWaNum(b.phone);
  if (customerNumber) {
    try {
      await trySend(customerNumber, "Customer");
    } catch (err) {
      console.error("Customer WA notify exception:", err.message);
    }
  } else {
    console.warn("handleBookingNotify: invalid customer phone:", b.phone);
  }

  return jsonResponse({ sent: adminOk }, 200, allowOrigin);
}
__name(handleBookingNotify, "handleBookingNotify");

// ── Fare rate table — MUST mirror BKM_VEHICLES in assets/js/main.js. ─────────
// This is the server's independent source of truth for "what should this
// trip cost", used to sanity-check the amount the client asks to charge.
// If you change a rate here, change it in main.js too (and vice versa).
const FARE_VEHICLES = {
  sedan:  { ow: 16, rt: 11, minFare: 1500 },
  ertiga: { ow: 21, rt: 15, minFare: 1700 },
  innova: { ow: 30, rt: 20, minFare: 2000 },
  tempo:  { ow: 42, rt: 35, minFare: 4000 },
};

// Independent server-side day count for round-trip packages — mirrors
// _bkmCalcDays() in main.js exactly (inclusive of both pickup and return
// dates: 7th to 10th is 4 days, not 3, since the vehicle/driver is engaged
// every calendar day in between including both ends). Returns null if
// either date is missing/unparseable, so callers can fall back safely.
function computeDaysFromDates(dateStr, retDateStr) {
  if (!dateStr || !retDateStr) return null;
  const d1 = new Date(dateStr);
  const d2 = new Date(retDateStr);
  if (isNaN(d1) || isNaN(d2)) return null;
  const diff = Math.ceil((d2 - d1) / (1000 * 60 * 60 * 24)) + 1;
  return Math.max(1, diff);
}
__name(computeDaysFromDates, "computeDaysFromDates");

// Recompute the fare the same way the booking widget does (see _bkmBuildCabs
// in main.js) from server-trusted inputs only (vehicle key, trip type,
// distance, stop count, round-trip day count). Returns null if the vehicle
// key isn't recognised, so callers can fail closed.
//
// dayCount prefers an independent recomputation from date/retDate (so a
// client can't just send an arbitrary "days" number to shrink the fare
// floor) and only falls back to the client-supplied `days` field when no
// dates were sent at all.
function computeExpectedFare({ vehicle, tripType, distKm, stops = 0, days = 1, date = null, retDate = null }) {
  const v = FARE_VEHICLES[String(vehicle || "").toLowerCase()];
  if (!v) return null;
  const km = Math.max(0, Number(distKm) || 0);
  const stopCount = Math.max(0, Number(stops) || 0);
  const datesDayCount = computeDaysFromDates(date, retDate);
  const dayCount = datesDayCount != null ? datesDayCount : Math.max(1, Number(days) || 1);

  if (tripType === "roundtrip") {
    const packageKm = 250 * dayCount;
    const billedKm = Math.max(km, packageKm);
    return Math.ceil(billedKm * v.rt) + dayCount * 300;
  }
  const perKm = Math.ceil(km * v.ow);
  const base = km < 100 ? Math.max(perKm, v.minFare) : perKm;
  return stopCount ? Math.ceil(base * (1 + 0.15 * stopCount)) : base;
}
__name(computeExpectedFare, "computeExpectedFare");

// How far the client-claimed amount is allowed to drift from our own
// recomputation before we reject it outright. Generous on purpose — Google
// Distance Matrix can return slightly different km between calls, and we'd
// rather allow a few rupees of rounding drift than block a real customer.
// A spoofed amount (e.g. ₹1 instead of ₹4,896) will be nowhere close to this.
const FARE_TOLERANCE_RUPEES = 50;
const FARE_TOLERANCE_RATIO = 0.1; // 10%

// ── Razorpay: create order ───────────────────────────────────────────────────
// Frontend calls this BEFORE opening the Razorpay checkout widget. Creating
// the order server-side (rather than trusting a client-supplied amount)
// means the amount that gets charged is always the amount we set, and gives
// us an order_id we can later use to verify the payment signature.
//
// SECURITY: amountRupees alone used to be trusted outright (clamped only to
// a 1–500000 sanity range), which meant anyone could open devtools and pay
// any amount they liked for a real booking. We now also recompute the
// expected fare server-side from vehicle/tripType/distKm/stops/days and
// reject if the claimed amount is implausibly far from it. The order amount
// actually sent to Razorpay is then PINNED in RATE_LIMIT_KV keyed by the
// Razorpay order id, so handleBookingNotify/handleCustomerConfirm can later
// check what was *actually* paid rather than trusting the client again.
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

  // Optional wallet credit applied toward this payment. Only honoured if
  // the request actually has a valid customer session AND that wallet
  // really has at least this much balance — never trusts a client-supplied
  // "I have ₹X in my wallet" claim. The wallet is debited for real here,
  // immediately, so it can't be "applied" twice across two separate
  // create-order calls for the same booking. Any failure path below this
  // point must roll the debit back (see walletApplied/walletPhone checks
  // further down) so a rejected or failed order never actually costs the
  // customer wallet money.
  let walletApplied = 0;
  let walletPhone = null;
  const claimedWalletUse = Math.max(0, Number(body.walletApplied) || 0);
  if (claimedWalletUse > 0) {
    const session = await getSession(env, request);
    if (session && session.role === "customer" && env.CRM_KV) {
      walletPhone = session.id;
      const wallet = await getWallet(env, session.id);
      walletApplied = Math.min(claimedWalletUse, wallet.balance);
      if (walletApplied > 0) {
        await applyWalletTransaction(
          env, session.id, "debit", walletApplied,
          `Applied to booking ${String(body.bookingId || "").slice(0, 40)}`,
          body.bookingId
        );
      }
    }
  }
  async function rollbackWallet() {
    if (walletApplied > 0 && walletPhone) {
      await applyWalletTransaction(env, walletPhone, "credit", walletApplied, "Reversed — order not created").catch(() => {});
    }
  }

  // Independent fare check. Only enforced when the client sends enough
  // context to compute it (vehicle + distKm) — requests with no vehicle
  // info fail closed rather than silently skipping the check. date/retDate
  // let the server recompute round-trip day count itself rather than
  // trusting a client-supplied "days" number, which would otherwise let
  // someone shrink the fare floor by sending a lower day count than their
  // actual trip dates imply.
  const expectedFare = computeExpectedFare({
    vehicle: body.vehicle,
    tripType: body.tripType,
    distKm: body.distKm,
    stops: body.stops,
    days: body.days,
    date: body.date,
    retDate: body.retDate
  });
  if (expectedFare == null) {
    await rollbackWallet();
    return jsonResponse({ error: "Missing trip details for fare verification" }, 400, allowOrigin);
  }
  // amountRupees here is the amount the customer chose to pay NOW (advance
  // or full), not necessarily the full fare — so the check allows anywhere
  // from a small advance up to the full fare (+tolerance). This still
  // catches "pay ₹1 for a ₹4,896 booking" without breaking the legitimate
  // 10%-advance flow. walletApplied widens the floor downward by exactly
  // the amount actually debited above — e.g. a ₹450 advance with ₹100 of
  // real wallet credit only needs to send ₹350 to Razorpay.
  const minAcceptable = Math.max(1, Math.floor(expectedFare * 0.05) - FARE_TOLERANCE_RUPEES - walletApplied);
  const maxAcceptable = Math.ceil(expectedFare * (1 + FARE_TOLERANCE_RATIO)) + FARE_TOLERANCE_RUPEES;
  if (amountRupees < minAcceptable || amountRupees > maxAcceptable) {
    console.warn(`Fare check failed — claimed ₹${amountRupees}, expected ~₹${expectedFare} (band ₹${minAcceptable}-₹${maxAcceptable})`);
    await rollbackWallet();
    return jsonResponse({ error: "Payment amount does not match the quoted fare. Please refresh and try again." }, 400, allowOrigin);
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
      await rollbackWallet();
      return jsonResponse({ error: "Could not initiate payment. Please try again." }, 502, allowOrigin);
    }

    // Pin this order's id -> claimed amount (and how much wallet credit was
    // applied) so a later "payment completed" notification can be checked
    // against what we actually told Razorpay to charge, instead of trusting
    // a second client-supplied number.
    if (env.RATE_LIMIT_KV && bookingId) {
      try {
        await env.RATE_LIMIT_KV.put(
          `order-amt:${rpData.id}`,
          JSON.stringify({ bookingId, amountRupees, walletApplied }),
          { expirationTtl: 86400 } // 24h — plenty of time to finish checkout
        );
      } catch (err) {
        console.error("order-amt KV write failed:", err.message);
      }
    }

    // key_id (the Razorpay "Key ID") is the public half of the pair — safe to
    // hand back to the browser, that's exactly what Checkout.js needs.
    return jsonResponse({
      order_id: rpData.id,
      amount: rpData.amount,
      currency: rpData.currency,
      key_id: keyId,
      walletApplied
    }, 200, allowOrigin);

  } catch (err) {
    console.error("Razorpay order request failed:", err.message);
    await rollbackWallet();
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

    // Signature checks out — this request really did come from a completed
    // Razorpay payment. Now look up what we actually told Razorpay to charge
    // when the order was created (handleCreateOrder pinned this), and issue a
    // one-time "payment confirmed" token carrying that real amount + booking
    // id. handleBookingNotify/handleCustomerConfirm require this token for
    // type:"payment" calls, so a forged "I paid!" WhatsApp trigger is no
    // longer possible — the only way to get this token is a signature that
    // only Razorpay (holder of the real payment) could have produced.
    let paidAmountRupees = null;
    let bookingId = null;
    let walletApplied = 0;
    if (env.RATE_LIMIT_KV) {
      try {
        const pinnedRaw = await env.RATE_LIMIT_KV.get(`order-amt:${orderId}`);
        if (pinnedRaw) {
          const pinned = JSON.parse(pinnedRaw);
          paidAmountRupees = Number(pinned.amountRupees) || null;
          bookingId = pinned.bookingId || null;
          walletApplied = Number(pinned.walletApplied) || 0;
        }
      } catch (err) {
        console.error("order-amt KV read failed:", err.message);
      }
    }

    // Total actually paid = what Razorpay charged + whatever wallet credit
    // was applied at create-order time (already debited for real then).
    const totalPaidRupees = paidAmountRupees != null ? paidAmountRupees + walletApplied : null;

    let paymentToken = null;
    if (env.RATE_LIMIT_KV && bookingId && totalPaidRupees != null) {
      paymentToken = generateToken();
      try {
        await env.RATE_LIMIT_KV.put(
          `payconfirm:${bookingId}`,
          JSON.stringify({ token: paymentToken, paymentId, orderId, amountRupees: totalPaidRupees }),
          { expirationTtl: 1800 } // 30 min — enough to finish the post-payment notify calls
        );
      } catch (err) {
        console.error("payconfirm KV write failed:", err.message);
        paymentToken = null;
      }
    } else {
      console.warn("handleVerifyPayment: no pinned order-amt found for order", orderId, "— notify will fail closed");
    }

    return jsonResponse({
      verified: true,
      order_id: orderId,
      payment_id: paymentId,
      booking_id: bookingId,
      payment_token: paymentToken
    }, 200, allowOrigin);
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

  // ── Trust gate ──────────────────────────────────────────────────────────
  // This message unconditionally says "Payment Completed" to the customer,
  // so it must require proof a real payment happened — the same payconfirm
  // record handleBookingNotify checks (written only by handleVerifyPayment
  // after a real Razorpay signature check). Without this, anyone could POST
  // an arbitrary phone number here and have it receive a fake payment
  // confirmation message.
  if (!env.RATE_LIMIT_KV) {
    return jsonResponse({ error: "Service temporarily unavailable" }, 500, allowOrigin);
  }
  let verifiedPaidAmount = 0;
  try {
    const raw = await env.RATE_LIMIT_KV.get(`payconfirm:${b.id}`);
    const confirm = raw ? JSON.parse(raw) : null;
    if (!confirm || confirm.token !== String(b.paymentToken || body.paymentToken || "")) {
      console.warn("handleCustomerConfirm: missing/invalid payment_token for booking", b.id);
      return jsonResponse({ error: "Payment could not be confirmed for this booking." }, 403, allowOrigin);
    }
    verifiedPaidAmount = Number(confirm.amountRupees) || 0;
  } catch (err) {
    console.error("payconfirm check failed:", err.message);
    return jsonResponse({ error: "Could not verify payment. Please try again." }, 500, allowOrigin);
  }

  const accessToken   = env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  const supportNumber = env.ADMIN_SUPPORT_NUMBER || env.ADMIN_WHATSAPP_NUMBER || "919355757579";

  if (!accessToken || !phoneNumberId) {
    console.warn("WhatsApp not configured — skipping customer confirmation");
    return jsonResponse({ sent: false, reason: "not_configured" }, 200, allowOrigin);
  }

  const stops = Array.isArray(b.extraCities) ? b.extraCities.filter(c => c.trim()) : [];
  const customerNumber = toWaNum(b.phone);
  if (!customerNumber) { console.warn("Invalid customer phone:", b.phone); return jsonResponse({ sent: false, reason: "invalid_phone" }, 200, allowOrigin); }
  // Use a dedicated customer-confirmation template (lighter, customer-facing).
  // Falls back to the admin v2 template if the customer template isn't set up yet.
  const customerConfirmTemplate = env.WHATSAPP_CUSTOMER_CONFIRM_TEMPLATE_NAME || "oneway_booking_confirmed";
  const notifTemplate = customerConfirmTemplate;

  // Template variables — must match oneway_notification_v2 exactly (12 params):
  // {{1}} Payment status   {{2}} Booking ID   {{3}} Name      {{4}} Phone
  // {{5}} Vehicle          {{6}} Trip type    {{7}} Pickup    {{8}} Drop
  // {{9}} Trip timing      {{10}} Paid amt    {{11}} Due amt  {{12}} Support number
  const isRoundTrip = b.tripType === "roundtrip";
  const pickupLoc   = `${b.from || "—"}${stops.length ? " → " + stops.join(" → ") : ""}`;
  const dropLoc     = isRoundTrip ? "Same as pickup (round trip)" : (b.to || "—");
  const vehicleType = b.vehicle || "—";
  const tripType    = isRoundTrip ? "Round Trip" : "One Way";
  // paidAmt now comes from the server-verified payconfirm record, not the
  // client-supplied b.payAmt, so it can no longer be spoofed.
  const paidAmt     = `₹${verifiedPaidAmount.toLocaleString("en-IN")}`;
  const dueAmt      = `₹${Number((b.fare || 0) - verifiedPaidAmount).toLocaleString("en-IN")}`;
  const tripTiming  = isRoundTrip && b.retdate
    ? `${b.date || "—"} ${b.time || ""}`.trim() + ` → Return ${b.retdate}`
    : `${b.date || "—"} ${b.time || ""}`.trim();
  const supportDisplay = `+91 ${String(supportNumber).replace(/^91/, "").replace(/(\d{5})(\d{5})/, "$1 $2")}`;

  const v2Payload = { messaging_product: "whatsapp", to: customerNumber, type: "template", template: { name: notifTemplate, language: { code: "en" }, components: [{ type: "body", parameters: [
    { type: "text", text: "Payment Completed" },
    { type: "text", text: String(b.id) },
    { type: "text", text: String(b.name) },
    { type: "text", text: localPhoneDigits(b.phone) },
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
    { type: "text", text: localPhoneDigits(b.phone) },
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

// ── Customer wallet ──────────────────────────────────────────────────────────
// Real KV-backed balance + ledger, not a UI mockup. There is deliberately
// NO endpoint that lets a customer add money to their own wallet directly —
// every credit must come from a legitimate server-side event (an admin
// approving a refund, or a referral bonus once a referred friend's first
// paid trip completes) so the balance can't be inflated by calling an API
// with a made-up amount. Debits happen when wallet balance is applied
// toward a new booking's advance payment.
async function getWallet(env, phone) {
  try {
    const raw = await env.CRM_KV.get(`wallet:${phone}`);
    if (raw) return JSON.parse(raw);
  } catch (err) {
    console.error("Wallet read failed for", phone, ":", err.message);
  }
  return { phone, balance: 0, updatedAt: null };
}
__name(getWallet, "getWallet");

// `type` is 'credit' or 'debit'. Returns the updated wallet. Debits are
// clamped so balance never goes negative (extra is silently capped, never
// charged elsewhere) — this only ever moves real previously-credited money,
// never creates new money on a debit.
async function applyWalletTransaction(env, phone, type, amount, reason, relatedBookingId = null) {
  const amt = Math.abs(Number(amount) || 0);
  if (!phone || !amt) return null;

  const wallet = await getWallet(env, phone);
  let delta = type === "credit" ? amt : -Math.min(amt, wallet.balance);
  wallet.balance = Math.max(0, Math.round((wallet.balance + delta) * 100) / 100);
  wallet.phone = phone;
  wallet.updatedAt = Date.now();
  await env.CRM_KV.put(`wallet:${phone}`, JSON.stringify(wallet));

  const txId = "wtx_" + generateToken().slice(0, 12);
  const tx = {
    id: txId, phone, type, amount: Math.abs(delta), reason: sanitizeString(reason || "", 200),
    relatedBookingId: relatedBookingId ? sanitizeString(String(relatedBookingId), 40) : null,
    createdAt: Date.now()
  };
  await env.CRM_KV.put(`wallet-tx:${txId}`, JSON.stringify(tx));
  await addToIndex(env, `wallet-tx-index:${phone}`, txId);

  return wallet;
}
__name(applyWalletTransaction, "applyWalletTransaction");

async function handleCustomerWallet(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "customer");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ wallet: { balance: 0 }, transactions: [] }, 200, allowOrigin);

  const phone = auth.session.id;
  const wallet = await getWallet(env, phone);
  const txIds = await readIndex(env, `wallet-tx-index:${phone}`);
  const records = await Promise.all(txIds.map(id => env.CRM_KV.get(`wallet-tx:${id}`)));
  const transactions = records.filter(Boolean).map(r => JSON.parse(r));

  return jsonResponse({ wallet, transactions }, 200, allowOrigin);
}
__name(handleCustomerWallet, "handleCustomerWallet");

// ── Saved routes ──────────────────────────────────────────────────────────────
// Real per-customer KV list, not a UI mockup. A "saved route" is just a
// from/to/vehicle combination the customer wants to quick-book again later
// — no fare is stored (fares are recomputed fresh, server-side, at booking
// time, same as every other booking) so a saved route can never go stale
// or be used to lock in an old/wrong price.
// ── Referral program ──────────────────────────────────────────────────────────
// Real, KV-backed — not a fake "your code is ABC123" display with no logic
// behind it. Design:
//   - Every customer's referral code is DERIVED deterministically from their
//     phone number (first 6 hex chars of HMAC-SHA256(phone)), so there's no
//     separate "generate code" step and it's stable across logins/devices.
//   - The first time a customer ever views their own code (GET below), we
//     write a reverse lookup (code -> phone) so other customers can redeem
//     it. This makes redemption self-bootstrapping with no separate "claim
//     my code" step the customer has to remember to do.
//   - A new customer can redeem someone else's code once. This just records
//     who referred them — no money moves yet.
//   - The actual bonus is credited later, by maybeCreditReferralBonus()
//     (called from handleBookingNotify), the moment the REFERRED customer's
//     first ever PAID booking is confirmed. That's the only point real
//     money is on the table, so it's the only point a bonus can be earned —
//     a code can't be redeemed for free money with no real trip behind it.
const REFERRAL_BONUS_RUPEES = 150;
const REFERRAL_SECRET = "owb-referral-v1"; // namespacing salt, not a real secret

async function getReferralCode(env, phone) {
  const hex = await hmacSha256Hex(REFERRAL_SECRET, phone);
  return hex.slice(0, 6).toUpperCase();
}
__name(getReferralCode, "getReferralCode");

async function handleCustomerReferral(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "customer");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);
  const phone = auth.session.id;

  if (request.method === "GET") {
    const code = await getReferralCode(env, phone);
    // Bootstrap the reverse lookup the first time this customer checks their
    // own code, so others can redeem it without a separate "claim" step.
    try { await env.CRM_KV.put(`referral-code-owner:${code}`, phone); } catch {}

    const raw = await env.CRM_KV.get(`referral:${phone}`);
    const record = raw ? JSON.parse(raw) : { phone, redeemedCode: null, createdAt: null };
    const useIds = await readIndex(env, `referral-uses:${phone}`);
    return jsonResponse({
      code,
      redeemedCode: record.redeemedCode,
      referralCount: useIds.length,
      bonusPerReferral: REFERRAL_BONUS_RUPEES
    }, 200, allowOrigin);
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }
    const enteredCode = sanitizeString(body.code, 10).toUpperCase();
    if (!enteredCode) return jsonResponse({ error: "Referral code required" }, 400, allowOrigin);

    const ownCode = await getReferralCode(env, phone);
    if (enteredCode === ownCode) {
      return jsonResponse({ error: "You can't refer yourself." }, 400, allowOrigin);
    }

    const existingRaw = await env.CRM_KV.get(`referral:${phone}`);
    const existing = existingRaw ? JSON.parse(existingRaw) : null;
    if (existing && existing.redeemedCode) {
      return jsonResponse({ error: "A referral code has already been applied to this account." }, 400, allowOrigin);
    }

    const referrerPhone = await env.CRM_KV.get(`referral-code-owner:${enteredCode}`);
    if (!referrerPhone) {
      return jsonResponse({ error: "Referral code not recognised. Ask your friend to open their Referrals tab first." }, 400, allowOrigin);
    }
    if (referrerPhone === phone) {
      return jsonResponse({ error: "You can't refer yourself." }, 400, allowOrigin);
    }

    await env.CRM_KV.put(`referral:${phone}`, JSON.stringify({
      phone, redeemedCode: enteredCode, referrerPhone, createdAt: Date.now(), bonusPaid: false
    }));
    await addToIndex(env, `referral-uses:${referrerPhone}`, phone);

    return jsonResponse({ redeemed: true, code: enteredCode }, 200, allowOrigin);
  }

  return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);
}
__name(handleCustomerReferral, "handleCustomerReferral");

// Called from handleBookingNotify on every successful payment — checks
// whether this is the paying customer's FIRST ever paid booking, and if so,
// whether they redeemed a referral code, and if so, pays the referrer their
// bonus exactly once (guarded by referral.bonusPaid).
async function maybeCreditReferralBonus(env, phone, bookingId) {
  if (!env.CRM_KV) return;
  try {
    const referralRaw = await env.CRM_KV.get(`referral:${phone}`);
    if (!referralRaw) return; // this customer never redeemed a code
    const referral = JSON.parse(referralRaw);
    if (referral.bonusPaid || !referral.referrerPhone) return;

    // "First paid booking" = exactly one paid duty exists for this phone
    // right now (this current one). We check the customer-duties index and
    // count how many of those duties already have advance > 0.
    const dutyIds = await readIndex(env, `customer-duties:${phone}`);
    const records = await Promise.all(dutyIds.map(id => env.CRM_KV.get(`duty:${id}`)));
    const paidCount = records.filter(Boolean).map(r => JSON.parse(r)).filter(d => Number(d.advance || 0) > 0).length;
    if (paidCount !== 1) return; // not their first paid booking

    await applyWalletTransaction(
      env, referral.referrerPhone, "credit", REFERRAL_BONUS_RUPEES,
      `Referral bonus — ${phone} completed their first paid booking`, bookingId
    );
    referral.bonusPaid = true;
    await env.CRM_KV.put(`referral:${phone}`, JSON.stringify(referral));
  } catch (err) {
    console.error("Referral bonus credit failed:", err.message);
  }
}
__name(maybeCreditReferralBonus, "maybeCreditReferralBonus");

// ── Customer profile ──────────────────────────────────────────────────────────
// A real, separate KV record — name/email/city the customer can edit
// themselves, distinct from whatever name was typed into any one booking
// form. Phone number itself is never editable here (it's literally the
// session identity), same as why driver.html keeps phone read-only.
async function handleCustomerProfile(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "customer");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);
  const phone = auth.session.id;

  if (request.method === "GET") {
    const raw = await env.CRM_KV.get(`customer-profile:${phone}`);
    let profile = raw ? JSON.parse(raw) : null;

    // First-ever visit: no profile saved yet. Rather than show a blank
    // form, prefill name/email from their most recent booking (if any) so
    // it doesn't feel like starting from zero — but this is just a
    // starting suggestion; nothing is written until they hit Save.
    if (!profile) {
      const dutyIds = await readIndex(env, `customer-duties:${phone}`);
      let latestName = "", latestEmail = "";
      if (dutyIds.length) {
        const records = await Promise.all(dutyIds.map(id => env.CRM_KV.get(`duty:${id}`)));
        const duties = records.filter(Boolean).map(r => JSON.parse(r)).sort((a, b) => b.createdAt - a.createdAt);
        if (duties[0]) { latestName = duties[0].name || ""; latestEmail = duties[0].email || ""; }
      }
      profile = { phone, name: latestName, email: latestEmail, city: "", updatedAt: null, saved: false };
    } else {
      profile.saved = true;
    }
    return jsonResponse({ profile }, 200, allowOrigin);
  }

  if (request.method === "POST" || request.method === "PUT") {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }
    const name = sanitizeString(body.name, 100);
    const email = sanitizeString(body.email, 150);
    const city = sanitizeString(body.city, 80);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse({ error: "Please enter a valid email address" }, 400, allowOrigin);
    }
    const profile = { phone, name, email, city, updatedAt: Date.now(), saved: true };
    await env.CRM_KV.put(`customer-profile:${phone}`, JSON.stringify(profile));
    return jsonResponse({ profile }, 200, allowOrigin);
  }

  return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);
}
__name(handleCustomerProfile, "handleCustomerProfile");

// ── Support tickets ───────────────────────────────────────────────────────────
// Real KV-backed tickets, visible to admin (handleAdminTicketList /
// handleAdminTicketUpdate below) — not a fake "ticket submitted!" alert
// that goes nowhere. Also fires a WhatsApp alert to the admin number, same
// as a new booking does, so a real ticket gets real, immediate attention
// rather than waiting for someone to happen to check a dashboard.
const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"];

async function handleCustomerTicketCreate(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "customer");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);
  const phone = auth.session.id;

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }
  const bookingId = sanitizeString(body.bookingId, 40);
  const issueType = sanitizeString(body.issueType, 60) || "Other";
  const description = sanitizeString(body.description, 1000);
  if (!description) return jsonResponse({ error: "Please describe the issue" }, 400, allowOrigin);

  // If a bookingId is given, it must actually belong to this customer —
  // otherwise drop it rather than let someone reference a stranger's
  // booking in a ticket.
  let verifiedBookingId = "";
  if (bookingId) {
    const raw = await env.CRM_KV.get(`duty:${bookingId}`);
    if (raw) {
      const duty = JSON.parse(raw);
      if (duty.phone === phone) verifiedBookingId = bookingId;
    }
  }

  const profileRaw = await env.CRM_KV.get(`customer-profile:${phone}`);
  const profile = profileRaw ? JSON.parse(profileRaw) : null;

  const id = "tkt_" + generateToken().slice(0, 12);
  const ticket = {
    id, phone, customerName: profile?.name || "", bookingId: verifiedBookingId,
    issueType, description, status: "open", createdAt: Date.now(), resolvedAt: null, adminNote: ""
  };
  await env.CRM_KV.put(`ticket:${id}`, JSON.stringify(ticket));
  await addToIndex(env, "ticket-index", id);
  await addToIndex(env, `customer-tickets:${phone}`, id);

  // Best-effort WhatsApp alert to admin — a KV/WhatsApp hiccup here should
  // never stop the ticket itself from being saved (that already happened above).
  try {
    const accessToken = env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
    const adminNumber = env.ADMIN_WHATSAPP_NUMBER || "919355757579";
    if (accessToken && phoneNumberId) {
      await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: adminNumber,
          type: "text",
          text: { body: `New support ticket ${id}\nFrom: +91 ${phone}\nIssue: ${issueType}\nBooking: ${verifiedBookingId || "—"}\n\n${description.slice(0, 300)}` }
        })
      });
    }
  } catch (err) {
    console.error("Ticket WhatsApp alert failed:", err.message);
  }

  return jsonResponse({ ticket }, 200, allowOrigin);
}
__name(handleCustomerTicketCreate, "handleCustomerTicketCreate");

async function handleCustomerTicketList(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "customer");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ tickets: [] }, 200, allowOrigin);
  const phone = auth.session.id;

  const ids = await readIndex(env, `customer-tickets:${phone}`);
  const records = await Promise.all(ids.map(id => env.CRM_KV.get(`ticket:${id}`)));
  const tickets = records.filter(Boolean).map(r => JSON.parse(r)).sort((a, b) => b.createdAt - a.createdAt);
  return jsonResponse({ tickets }, 200, allowOrigin);
}
__name(handleCustomerTicketList, "handleCustomerTicketList");

// Admin-side: list all tickets, and update status/note — same role-gated
// pattern as handleRefundList/handleRefundUpdate.
async function handleAdminTicketList(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  const ids = await readIndex(env, "ticket-index");
  const records = await Promise.all(ids.map(id => env.CRM_KV.get(`ticket:${id}`)));
  const tickets = records.filter(Boolean).map(r => JSON.parse(r)).sort((a, b) => b.createdAt - a.createdAt);
  return jsonResponse({ tickets }, 200, allowOrigin);
}
__name(handleAdminTicketList, "handleAdminTicketList");

async function handleAdminTicketUpdate(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "admin");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }
  const id = sanitizeString(body.id, 40);
  if (!id) return jsonResponse({ error: "Ticket id is required" }, 400, allowOrigin);
  if (!TICKET_STATUSES.includes(body.status)) {
    return jsonResponse({ error: `status must be one of: ${TICKET_STATUSES.join(", ")}` }, 400, allowOrigin);
  }

  const raw = await env.CRM_KV.get(`ticket:${id}`);
  if (!raw) return jsonResponse({ error: "Ticket not found" }, 404, allowOrigin);
  const ticket = JSON.parse(raw);

  ticket.status = body.status;
  ticket.adminNote = sanitizeString(body.adminNote || ticket.adminNote || "", 500);
  ticket.resolvedAt = ["resolved", "closed"].includes(body.status) ? Date.now() : null;
  await env.CRM_KV.put(`ticket:${id}`, JSON.stringify(ticket));
  return jsonResponse({ ticket }, 200, allowOrigin);
}
__name(handleAdminTicketUpdate, "handleAdminTicketUpdate");

async function handleCustomerRoutes(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "customer");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);
  const phone = auth.session.id;

  if (request.method === "GET") {
    const ids = await readIndex(env, `saved-routes:${phone}`);
    const records = await Promise.all(ids.map(id => env.CRM_KV.get(`saved-route:${id}`)));
    const routes = records.filter(Boolean).map(r => JSON.parse(r)).sort((a, b) => b.createdAt - a.createdAt);
    return jsonResponse({ routes }, 200, allowOrigin);
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }
    const from = sanitizeString(body.from, 120);
    const to = sanitizeString(body.to, 120);
    const vehicle = sanitizeString(body.vehicle, 30);
    if (!from || !to) return jsonResponse({ error: "from and to are required" }, 400, allowOrigin);

    const ids = await readIndex(env, `saved-routes:${phone}`);
    if (ids.length >= 25) {
      return jsonResponse({ error: "You can save up to 25 routes. Remove one before adding another." }, 400, allowOrigin);
    }

    const id = "route_" + generateToken().slice(0, 12);
    const route = { id, phone, from, to, vehicle: vehicle || "sedan", createdAt: Date.now() };
    await env.CRM_KV.put(`saved-route:${id}`, JSON.stringify(route));
    await addToIndex(env, `saved-routes:${phone}`, id);
    return jsonResponse({ route }, 200, allowOrigin);
  }

  if (request.method === "DELETE") {
    const url = new URL(request.url);
    const id = String(url.searchParams.get("id") || "");
    if (!id) return jsonResponse({ error: "Missing route id" }, 400, allowOrigin);

    const raw = await env.CRM_KV.get(`saved-route:${id}`);
    if (!raw) return jsonResponse({ error: "Route not found" }, 404, allowOrigin);
    const route = JSON.parse(raw);
    if (route.phone !== phone) return jsonResponse({ error: "Not authorized" }, 403, allowOrigin);

    await env.CRM_KV.delete(`saved-route:${id}`);
    await removeFromIndex(env, `saved-routes:${phone}`, id);
    return jsonResponse({ deleted: true }, 200, allowOrigin);
  }

  return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);
}
__name(handleCustomerRoutes, "handleCustomerRoutes");

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

// ── Customer login ────────────────────────────────────────────────────────
// Customers don't have passwords — logging in to "My Bookings" reuses the
// SAME OTP flow as the booking widget (otp/send + otp/verify). The frontend
// sends the phone + the `token` it got back from otp/verify; we check that
// against the verified:<phone> record (set by handleVerifyOtp) exactly the
// way handleBookingNotify does, then issue a normal CRM session with
// role:"customer" so requireRole()/getSession() work unchanged for this
// role too.
async function handleCustomerLogin(request, env, allowOrigin) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, allowOrigin);
  if (!env.RATE_LIMIT_KV) return jsonResponse({ error: "Service temporarily unavailable" }, 500, allowOrigin);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400, allowOrigin); }

  const phone = validatePhone(body.phone);
  const otpToken = String(body.otpToken || body.verifyToken || "");
  if (!phone || !otpToken) return jsonResponse({ error: "Phone and verification token required" }, 400, allowOrigin);

  try {
    const storedToken = await env.RATE_LIMIT_KV.get(`verified:${phone}`);
    if (!storedToken || storedToken !== otpToken) {
      return jsonResponse({ error: "Phone not verified. Please verify via OTP first." }, 403, allowOrigin);
    }
  } catch (err) {
    console.error("Customer login verify check failed:", err.message);
    return jsonResponse({ error: "Could not verify request. Please try again." }, 500, allowOrigin);
  }

  const token = await createSession(env, "customer", phone);
  return jsonResponse({ token, phone, role: "customer" }, 200, allowOrigin);
}
__name(handleCustomerLogin, "handleCustomerLogin");

// A logged-in customer's own bookings, newest first — looked up via the
// customer-duties:<phone> index saveDutyFromBooking() maintains. Scoped
// strictly to the session's own phone number; there is no way to pass in
// someone else's phone and see their bookings.
async function handleCustomerBookings(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "customer");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ bookings: [] }, 200, allowOrigin);

  const phone = auth.session.id;
  const ids = await readIndex(env, `customer-duties:${phone}`);
  const records = await Promise.all(ids.map(id => env.CRM_KV.get(`duty:${id}`)));
  const bookings = records.filter(Boolean).map(r => JSON.parse(r));

  return jsonResponse({ bookings, phone }, 200, allowOrigin);
}
__name(handleCustomerBookings, "handleCustomerBookings");

// Real PDF invoice for one of the logged-in customer's own bookings.
// `?id=<dutyId>` — ownership is checked against the session's phone, NOT
// against anything the client claims, so one customer can never download
// another's invoice by guessing/incrementing booking IDs.
async function handleCustomerInvoice(request, env, allowOrigin) {
  const auth = await requireRole(env, request, "customer");
  if (auth.error) return auth.error;
  if (!env.CRM_KV) return jsonResponse({ error: "CRM not configured" }, 500, allowOrigin);

  const url = new URL(request.url);
  const dutyId = String(url.searchParams.get("id") || "");
  if (!dutyId) return jsonResponse({ error: "Missing booking id" }, 400, allowOrigin);

  const raw = await env.CRM_KV.get(`duty:${dutyId}`);
  if (!raw) return jsonResponse({ error: "Booking not found" }, 404, allowOrigin);

  let duty;
  try { duty = JSON.parse(raw); } catch { return jsonResponse({ error: "Booking data corrupted" }, 500, allowOrigin); }

  if (duty.phone !== auth.session.id) {
    return jsonResponse({ error: "Not authorized to view this invoice" }, 403, allowOrigin);
  }
  if (Number(duty.advance || 0) <= 0) {
    return jsonResponse({ error: "No payment recorded yet for this booking — invoice not available." }, 400, allowOrigin);
  }

  const pdf = buildInvoicePdf(duty);
  return pdfResponse(pdf, `invoice-${dutyId}.pdf`, allowOrigin);
}
__name(handleCustomerInvoice, "handleCustomerInvoice");

// ── Duties ────────────────────────────────────────────────────────────────────
// A duty record looks like:
// {
//   id, name, phone, from, to, extraCities, date, time, fare, advance,
//   vehicleType, status: 'new'|'assigned'|'ongoing'|'completed'|'cancelled',
//   driverId, driverName, driverPhone, vehicleNumber, createdAt, assignedAt
// }
// `verifiedPaidAmount` is the amount handleBookingNotify already confirmed
// via the payconfirm KV record (itself only written after a real Razorpay
// signature check) — NOT read from `b` here, since `b` is client-supplied
// and the whole point of this parameter is to not trust that for money.
async function saveDutyFromBooking(env, b, verifiedPaidAmount = 0) {
  const id = String(b.id);
  const existingRaw = await env.CRM_KV.get(`duty:${id}`);
  const isPaymentDone = b.type === "payment";
  const actuallyPaid = isPaymentDone ? Number(verifiedPaidAmount || 0) : 0;

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
  if (duty.phone) await addToIndex(env, `customer-duties:${duty.phone}`, id);
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
    // Mark flag BEFORE the KV write so the persisted record reflects whether
    // the message was sent — prevents a double-send if this handler is retried.
    duty.reviewRequestSent = reviewRequestSent;
  }

  // Always persist duty state (status + reviewRequestSent flag) before responding.
  await env.CRM_KV.put(`duty:${dutyId}`, JSON.stringify(duty));

  // If review send failed (e.g. template not approved yet), retry once after
  // persisting — this way the duty is already saved as completed even if the
  // review WA call hangs or errors a second time.
  if (newStatus === "completed" && !wasAlreadyCompleted && !reviewRequestSent) {
    sendReviewRequest(env, duty).then(ok => {
      if (ok) {
        duty.reviewRequestSent = true;
        env.CRM_KV.put(`duty:${dutyId}`, JSON.stringify(duty)).catch(() => {});
        console.log("Review request sent on retry");
      }
    }).catch(() => {});
  }

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
  const reviewLink = env.GOOGLE_REVIEW_LINK;
  if (!reviewLink) {
    console.warn("GOOGLE_REVIEW_LINK secret not set — skipping review request to avoid sending placeholder link");
    return false;
  }
  const customerNumber = toWaNum(duty.phone);
  if (!customerNumber) { console.warn("Review: invalid customer phone:", duty.phone); return false; }

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

  // 1) Driver — driverPhone is stored as the raw number (no country code prefix),
  // matching how it was saved from driverId. Prefix 91 for WhatsApp.
  const driverWaNum = toWaNum(duty.driverPhone);
  if (!driverWaNum) { console.warn("Assignment: invalid driver phone:", duty.driverPhone); results.driver = false; }
  results.driver = await send(driverWaNum, driverTemplate, [
    { type: "text", text: String(duty.id) },
    { type: "text", text: String(duty.name) },
    { type: "text", text: localPhoneDigits(duty.phone) },
    { type: "text", text: pickup },
    { type: "text", text: duty.to || "—" },
    { type: "text", text: tripTiming },
    { type: "text", text: vehicleLabel },
    { type: "text", text: fareLabel }
  ], "Driver");

  // 2) Customer — gets driver + vehicle confirmation
  const customerWaNum = toWaNum(duty.phone);
  if (!customerWaNum) { console.warn("Assignment: invalid customer phone:", duty.phone); results.customer = false; }
  results.customer = await send(customerWaNum, customerTemplate, [
    { type: "text", text: String(duty.id) },
    { type: "text", text: String(duty.driverName) },
    { type: "text", text: localPhoneDigits(duty.driverPhone) },
    { type: "text", text: vehicleLabel },
    { type: "text", text: pickup },
    { type: "text", text: tripTiming }
  ], "Customer");

  // 3) Admin — internal heads-up reusing the existing notification template
  results.admin = await send(adminNumber, adminTemplate, [
    { type: "text", text: String(duty.id) },
    { type: "text", text: `Assigned: ${duty.driverName}` },
    { type: "text", text: localPhoneDigits(duty.driverPhone) },
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

  // Refund approved -> credit the customer's wallet for real. Guarded by
  // refund.walletCredited so re-saving an already-processed refund (e.g.
  // admin re-submits the same status) can't double-credit the wallet.
  if (body.status === "processed" && !refund.walletCredited && refund.customerPhone) {
    try {
      await applyWalletTransaction(
        env, refund.customerPhone, "credit", refund.amount,
        `Refund — Booking ${refund.bookingId}`, refund.bookingId
      );
      refund.walletCredited = true;
      await env.CRM_KV.put(`refund:${id}`, JSON.stringify(refund));
    } catch (err) {
      console.error("Wallet credit on refund failed:", err.message);
    }
  }

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

// ── Minimal PDF generator ─────────────────────────────────────────────────
// Workers run as a single bundled file with no native deps and no
// filesystem — pulling in a full PDF library isn't practical here, and
// isn't needed for a simple one-page text invoice. This hand-writes valid
// PDF 1.4 syntax directly: a handful of objects (catalog, pages, page, two
// base-14 fonts, one content stream) plus an xref table. No external
// dependency, no embedded font program, no images — just text positioned
// with absolute Tm coordinates and a couple of ruled lines.
//
// NOTE: standard PDF base fonts (Helvetica/Helvetica-Bold) don't include
// the ₹ glyph without embedding a custom font program, which would add a
// lot of complexity for a one-page invoice. We use "Rs." in the PDF text
// instead — the rest of the site keeps using ₹ in HTML, where it renders
// fine as UTF-8.
function pdfEscape(str) {
  return String(str).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
__name(pdfEscape, "pdfEscape");

function buildSimplePdf(drawFn) {
  const ops = [];
  const api = {
    text(x, y, str, font = "F1", size = 10) {
      ops.push(`BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfEscape(str)}) Tj ET`);
    },
    line(x1, y1, x2, y2, w = 0.5) {
      ops.push(`${w} w ${x1} ${y1} m ${x2} ${y2} l S`);
    }
  };
  drawFn(api);

  const content = ops.join("\n");
  const contentBytes = new TextEncoder().encode(content);

  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /MediaBox [0 0 612 792] /Contents 6 0 R >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`,
    `<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach(off => { pdf += String(off).padStart(10, "0") + " 00000 n \n"; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return pdf;
}
__name(buildSimplePdf, "buildSimplePdf");

// Builds the actual invoice layout for one duty record. `d.fare` is treated
// as GST-inclusive (matches what policies.html tells customers: the fare
// shown already includes GST + state taxes), so GST here is a derived
// reverse-calculation at a flat 5%, not a stored per-booking tax field —
// same honesty caveat as handleGstSummary: a basic breakdown, not a
// GSTR-1-compliant tax document.
function buildInvoicePdf(d) {
  const fare = Number(d.fare || 0);
  const paid = Number(d.advance || 0);
  const due = Math.max(0, fare - paid);
  const baseFare = Math.round((fare / 1.05) * 100) / 100;
  const gst = Math.round((fare - baseFare) * 100) / 100;
  const fmt = n => Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  const route = `${d.from || "—"}${(d.extraCities||[]).filter(Boolean).length ? " -> " + d.extraCities.filter(Boolean).join(" -> ") : ""} -> ${d.to || "—"}`;
  const invoiceDate = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

  return buildSimplePdf(({ text, line }) => {
    let y = 760;
    text(50, y, "One-Way Bhaarat Pvt. Ltd.", "F2", 16); y -= 16;
    text(50, y, "Tax Invoice", "F2", 11); y -= 20;
    text(50, y, `Invoice No: INV-${d.id}`, "F1", 9);
    text(350, y, `Date: ${invoiceDate}`, "F1", 9); y -= 14;
    text(50, y, `Booking ID: ${d.id}`, "F1", 9); y -= 20;

    line(50, y, 562, y); y -= 16;
    text(50, y, "Billed To:", "F2", 10); y -= 14;
    text(50, y, d.name || "—", "F1", 9); y -= 12;
    text(50, y, d.phone ? `+91 ${d.phone}` : "—", "F1", 9); y -= 20;

    line(50, y, 562, y); y -= 16;
    text(50, y, "Trip Details", "F2", 10); y -= 16;
    text(50, y, "Route:", "F1", 9); text(150, y, route, "F1", 9); y -= 14;
    text(50, y, "Vehicle:", "F1", 9); text(150, y, d.vehicleType || "—", "F1", 9); y -= 14;
    text(50, y, "Date:", "F1", 9); text(150, y, `${d.date || "—"} ${d.time || ""}`.trim(), "F1", 9); y -= 14;
    text(50, y, "Trip Type:", "F1", 9); text(150, y, d.tripType === "roundtrip" ? "Round Trip" : "One Way", "F1", 9); y -= 20;

    line(50, y, 562, y); y -= 16;
    text(50, y, "Charges", "F2", 10); y -= 16;
    text(50, y, "Base Fare", "F1", 9); text(450, y, `Rs. ${fmt(baseFare)}`, "F1", 9); y -= 14;
    text(50, y, "GST (5%, incl.)", "F1", 9); text(450, y, `Rs. ${fmt(gst)}`, "F1", 9); y -= 8;
    line(400, y, 562, y, 0.5); y -= 8;
    text(50, y, "Total Fare", "F2", 9); text(450, y, `Rs. ${fmt(fare)}`, "F2", 9); y -= 14;
    text(50, y, "Amount Paid", "F1", 9); text(450, y, `Rs. ${fmt(paid)}`, "F1", 9); y -= 14;
    text(50, y, "Balance Due", "F1", 9); text(450, y, `Rs. ${fmt(due)}`, "F1", 9); y -= 24;

    text(50, y, "This is a computer-generated invoice and does not require a signature.", "F1", 8); y -= 12;
    text(50, y, "Basic GST breakdown derived from the total fare at a flat 5% rate — not a GSTR-1-compliant filing document.", "F1", 7);
  });
}
__name(buildInvoicePdf, "buildInvoicePdf");

function pdfResponse(pdfString, filename, allowOrigin = null) {
  const headers = {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
  if (allowOrigin) headers["Access-Control-Allow-Origin"] = allowOrigin;
  // PDF content is latin1-safe (we only ever write ASCII into it above), so
  // a plain byte-for-byte encode is enough — no need for base64 round-tripping.
  const bytes = new Uint8Array(pdfString.length);
  for (let i = 0; i < pdfString.length; i++) bytes[i] = pdfString.charCodeAt(i) & 0xff;
  return new Response(bytes, { status: 200, headers });
}
__name(pdfResponse, "pdfResponse");

function jsonResponse(data, status = 200, allowOrigin = null) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
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
