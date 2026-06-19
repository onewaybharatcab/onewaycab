async function handlePlacesProxy(request, url, env) {
  if (request.method === "OPTIONS") return corsPreflight();
  
  const input = url.searchParams.get("input") || "";
  const sessionToken = url.searchParams.get("sessiontoken") || "";
  
  // Adjusted constraint check to allow 2+ characters smoothly
  if (input.length < 2) return jsonResponse({ predictions: [], status: "ZERO_RESULTS" });
  
  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: "GOOGLE_PLACES_API_KEY not set in Cloudflare secrets" }, 500);
  }

  // Places API (New) Endpoint for Autocomplete
  const gUrl = "https://places.googleapis.com/v1/places:autocomplete";

  // Request Payload for Places API (New)
  const payload = {
    input: input,
    includedRegionCodes: ["in"],      // Replaced components country:in
    includedPrimaryTypes: ["geocode"], // Replaced types
    languageCode: "en"                 // Replaced language
  };

  if (sessionToken) payload.sessionToken = sessionToken;

  try {
    const res = await fetch(gUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    
    // Map the new response structure back to your frontend's existing expected structure
    const predictions = (data.suggestions || []).map((s) => {
      const p = s.placePrediction;
      return {
        place_id: p.placeId,
        description: p.text?.text,
        main_text: p.structuredFormat?.mainText?.text,
        secondary_text: p.structuredFormat?.secondaryText?.text
      };
    });

    return jsonResponse({
      status: predictions.length > 0 ? "OK" : "ZERO_RESULTS",
      predictions: predictions
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

  // Places API (New) Endpoint for Place Details
  const gUrl = `https://places.googleapis.com/v1/places/${placeId}`;

  try {
    const res = await fetch(gUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        // New API requires explicit FieldMasking to receive specific data fields
        "X-Goog-FieldMask": "displayName,formattedAddress,location"
      }
    });

    const data = await res.json();
    
    if (!data || data.error) return jsonResponse({ error: data.error?.message || "Error fetching details" }, 400);

    // Map the data to your frontend layout expectations
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
__name(handlePlaceDetails, "handlePlaceDetails");