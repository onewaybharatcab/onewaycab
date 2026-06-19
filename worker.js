export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return corsPreflight();

    if (url.pathname === "/api/places/autocomplete") {
      return handlePlacesProxy(request, url, env);
    }

    if (url.pathname === "/api/places/details") {
      return handlePlaceDetails(url, env);
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function handlePlacesProxy(request, url, env) {
  const input = url.searchParams.get("input") || "";
  const sessionToken = url.searchParams.get("sessiontoken") || "";

  if (input.length < 2) return jsonResponse({ predictions: [], status: "ZERO_RESULTS" });

  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return jsonResponse({ error: "GOOGLE_PLACES_API_KEY not set in Cloudflare secrets" }, 500);

  const payload = {
    input,
    includedRegionCodes: ["in"],
    includedPrimaryTypes: ["geocode"],
    languageCode: "en"
  };
  if (sessionToken) payload.sessionToken = sessionToken;

  try {
    const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    const predictions = (data.suggestions || []).map((s) => {
      const p = s.placePrediction;
      return {
        place_id: p.placeId,
        description: p.text?.text,
        main_text: p.structuredFormat?.mainText?.text,
        secondary_text: p.structuredFormat?.secondaryText?.text
      };
    });
    return jsonResponse({ status: predictions.length > 0 ? "OK" : "ZERO_RESULTS", predictions });
  } catch (err) {
    return jsonResponse({ error: err.message }, 502);
  }
}

async function handlePlaceDetails(url, env) {
  const placeId = url.searchParams.get("place_id") || "";
  if (!placeId) return jsonResponse({ error: "place_id required" }, 400);

  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return jsonResponse({ error: "GOOGLE_PLACES_API_KEY not set" }, 500);

  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "displayName,formattedAddress,location"
      }
    });
    const data = await res.json();
    if (!data || data.error) return jsonResponse({ error: data.error?.message || "Error fetching details" }, 400);
    return jsonResponse({
      name: data.displayName?.text || "",
      address: data.formattedAddress || "",
      lat: data.location?.latitude,
      lng: data.location?.longitude
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 502);
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
