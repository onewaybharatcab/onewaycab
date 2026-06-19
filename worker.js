var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
import INDEX_HTML from "./41635db7140708565d4a3f491d1d2760327521ca-index.html";
import BOOKING_HTML from "./043fe5e4e605b217846ce378f134ac7cd71cce6d-booking.html";
import ABOUT_HTML from "./6e0314baf43f05d15db77c27a8a5ae85fda8e400-about.html";
import ADMIN_HTML from "./a16bfcac6f9a1f0fc86c633af3ba69e1efb0ebb1-admin.html";
import BLOG_HTML from "./6ee79f77a9d8b68ffc132177e450a2729322742d-blog.html";
import CONTACT_HTML from "./0b6dee1f686187439dfee33719c86acecbc471b4-contact.html";
import CUSTOMER_HTML from "./e0514d66a8ef7df30ef0269acba2cec684258f89-customer.html";
import DRIVER_HTML from "./0be7650ff9c3a73c1f926e0e27363e09261878fe-driver.html";
import FAQ_HTML from "./54fedc74274208f118bce556a36d4c66b623d5d0-faq.html";
import FLEET_HTML from "./8a78ef380e0deb61d2432c0f9efc3d533b45222b-fleet.html";
import POLICIES_HTML from "./ba25a31e8f585b0dfdae2b36b87118275cea6822-policies.html";
import ROUTES_HTML from "./141ebca493952b59cf33362f0160f322baf9e13e-routes.html";

var PAGES = {
  "/": INDEX_HTML,
  "/index.html": INDEX_HTML,
  "/booking.html": BOOKING_HTML,
  "/about.html": ABOUT_HTML,
  "/admin.html": ADMIN_HTML,
  "/blog.html": BLOG_HTML,
  "/contact.html": CONTACT_HTML,
  "/customer.html": CUSTOMER_HTML,
  "/driver.html": DRIVER_HTML,
  "/faq.html": FAQ_HTML,
  "/fleet.html": FLEET_HTML,
  "/policies.html": POLICIES_HTML,
  "/routes.html": ROUTES_HTML
};

var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 1. Check details FIRST so it doesn't get caught by the general places path
    if (url.pathname.includes("detail")) {
      return handlePlaceDetails(url, env);
    }
    
    // 2. Safely handle any variations of the autocomplete route
    if (url.pathname.startsWith("/api/places")) {
      return handlePlacesProxy(request, url, env);
    }
    
    // 3. Serve frontend static views
    const html = PAGES[url.pathname];
    if (html) return serveHTML(html, env);
    return new Response("Not found", { status: 404 });
  }
};

function serveHTML(html, env) {
  const finalHTML = html.replace("__GOOGLE_PLACES_API_KEY__", env.GOOGLE_PLACES_API_KEY || "");
  return new Response(finalHTML, {
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
__name(serveHTML, "serveHTML");

async function handlePlacesProxy(request, url, env) {
  if (request.method === "OPTIONS") return corsPreflight();
  const input = url.searchParams.get("input") || "";
  const sessionToken = url.searchParams.get("sessiontoken") || "";
  if (input.length < 2) return jsonResponse({ predictions: [], status: "ZERO_RESULTS" });

  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: "GOOGLE_PLACES_API_KEY not set in Cloudflare secrets" }, 500);
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
    return jsonResponse({
      status: data.status,
      predictions: (data.predictions || []).map((p) => ({
        place_id: p.place_id,
        description: p.description,
        main_text: p.structured_formatting?.main_text,
        secondary_text: p.structured_formatting?.secondary_text
      }))
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 502);
  }
}
__name(handlePlacesProxy, "handlePlacesProxy");

async function handlePlaceDetails(url, env) {
  const placeId = url.searchParams.get("place_id") || "";
  const sessionToken = url.searchParams.get("sessiontoken") || "";
  if (!placeId) return jsonResponse({ error: "place_id required" }, 400);

  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return jsonResponse({ error: "GOOGLE_PLACES_API_KEY not set" }, 500);

  const gUrl = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  gUrl.searchParams.set("place_id", placeId);
  gUrl.searchParams.set("key", apiKey);
  gUrl.searchParams.set("fields", "name,formatted_address,geometry");
  gUrl.searchParams.set("language", "en");
  
  if (sessionToken) gUrl.searchParams.set("sessiontoken", sessionToken);

  try {
    const res = await fetch(gUrl.toString());
    const data = await res.json();
    if (data.status !== "OK") return jsonResponse({ error: data.status }, 400);
    const r = data.result;
    return jsonResponse({
      name: r.name,
      address: r.formatted_address,
      lat: r.geometry?.location?.lat,
      lng: r.geometry?.location?.lng
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 502);
  }
}
__name(handlePlaceDetails, "handlePlaceDetails");

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
__name(jsonResponse, "jsonResponse");

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
__name(corsPreflight, "corsPreflight");

export {
  worker_default as default
};