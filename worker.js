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

var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : null;

    // 1. OTP endpoints (booking-flow phone verification via WhatsApp)
    if (url.pathname.includes("otp/send")) {
      return withRateLimit(request, env, ctx, "otp-send", () => handleSendOtp(request, env, allowOrigin), allowOrigin, OTP_SEND_RATE_LIMIT_MAX);
    }
    if (url.pathname.includes("otp/verify")) {
      return withRateLimit(request, env, ctx, "otp-verify", () => handleVerifyOtp(request, env, allowOrigin), allowOrigin, OTP_VERIFY_RATE_LIMIT_MAX);
    }

    // 2. Booking notification (admin WhatsApp alert when booking confirmed)
    if (url.pathname.includes("booking/notify")) {
      return withRateLimit(request, env, ctx, "notify", () => handleBookingNotify(request, env, allowOrigin), allowOrigin);
    }

    // 2. Distance Matrix endpoint — used by booking modal to get road distance + ETA
    if (url.pathname.includes("distance")) {
      return withRateLimit(request, env, ctx, "distance", () => handleDistance(request, url, env, allowOrigin), allowOrigin);
    }

    // 3. Details endpoint logic (Matches detail, details, or place_id queries)
    if (url.pathname.includes("detail") || url.searchParams.has("place_id")) {
      return withRateLimit(request, env, ctx, "details", () => handlePlaceDetails(request, url, env, allowOrigin), allowOrigin);
    }

    // 4. Broad Autocomplete logic (Matches /api/places, /api/place, /api/autocomplete)
    if (url.pathname.includes("place") || url.pathname.includes("autocomplete")) {
      return withRateLimit(request, env, ctx, "places", () => handlePlacesProxy(request, url, env, allowOrigin), allowOrigin);
    }

    // Fallback response if asset router runs out of scope
    return new Response("Asset mapping requires direct static build configuration or asset binding.", { status: 404 });
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

  const rawPhone = String(body.phone || "").replace(/\D/g, "");
  if (rawPhone.length !== 10) {
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
            { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: otp }] }
          ]
        }
      })
    });

    const waData = await waRes.json();
    if (!waRes.ok) {
      console.error("WhatsApp send failed:", JSON.stringify(waData));
      return jsonResponse({ error: "Could not send OTP. Please try again." }, 502, allowOrigin);
    }
  } catch (err) {
    console.error("WhatsApp API request failed:", err.message);
    return jsonResponse({ error: "Could not send OTP. Please try again." }, 502, allowOrigin);
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

  const rawPhone = String(body.phone || "").replace(/\D/g, "");
  const code = String(body.code || "").replace(/\D/g, "");
  if (rawPhone.length !== 10 || code.length !== 6) {
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

  const adminNumber  = env.ADMIN_WHATSAPP_NUMBER || "919355757579"; // e.g. 919355757579
  const accessToken  = env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;

  if (!accessToken || !phoneNumberId) {
    // Non-fatal — admin notification is best-effort, don't fail the booking
    console.warn("WhatsApp admin notification not configured — skipping");
    return jsonResponse({ sent: false, reason: "not_configured" }, 200, allowOrigin);
  }

  // Build the message text
  const isPayment = b.type === "payment";
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
