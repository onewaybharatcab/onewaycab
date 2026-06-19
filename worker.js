var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 1. Details endpoint logic (Matches /api/places/details or /api/place-details)
    if (url.pathname.includes("detail")) {
      return handlePlaceDetails(url, env);
    }
    
    // 2. Autocomplete endpoint logic (Matches /api/places or /api/places/autocomplete)
    if (url.pathname.startsWith("/api/places")) {
      return handlePlacesProxy(request, url, env);
    }
    
    // Fallback response if asset router runs out of scope
    return new Response("Asset mapping requires direct static build configuration or asset binding.", { status: 404 });
  }
};

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