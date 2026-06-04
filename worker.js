/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║       One-Way Bhaarat — Cloudflare Worker                   ║
 * ║                                                              ║
 * ║  Serves index.html with secrets injected server-side.       ║
 * ║  The Google API key is NEVER exposed in browser source.     ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Environment variables (set in Cloudflare Dashboard → Settings → Variables):
 *
 *   Secret  :  GOOGLE_PLACES_API_KEY   ← your Google Places API key
 *   Variable:  SITE_ENV                ← "production" or "staging"
 */

// ── HTML asset is bundled via wrangler (see wrangler.toml) ──────────────────
import HTML from '../public/index.html';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── Route: serve main page ──────────────────────────────────────────────
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return serveHTML(env);
    }

    // ── Route: Places Autocomplete proxy (keeps key server-side) ───────────
    // Frontend calls /api/places?input=Delhi instead of Google directly
    if (url.pathname === '/api/places') {
      return handlePlacesProxy(request, url, env);
    }

    // ── Route: Place Details proxy (get lat/lng for a place_id) ────────────
    if (url.pathname === '/api/place-details') {
      return handlePlaceDetails(url, env);
    }

    // ── 404 for anything else ───────────────────────────────────────────────
    return new Response('Not found', { status: 404 });
  }
};

// ════════════════════════════════════════════════════════════════
//  Serve HTML — inject API key into the <script src> tag
// ════════════════════════════════════════════════════════════════
function serveHTML(env) {
  const apiKey = env.GOOGLE_PLACES_API_KEY || '';

  // Replace the token placeholder with the real key at request time
  const finalHTML = HTML.replace('__GOOGLE_PLACES_API_KEY__', apiKey);

  return new Response(finalHTML, {
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      // Security headers
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      // Cache HTML for 5 min (so key changes propagate quickly)
      'Cache-Control': 'public, max-age=300',
    }
  });
}

// ════════════════════════════════════════════════════════════════
//  Places Autocomplete Proxy
//  GET /api/places?input=Delhi&sessiontoken=abc123
//  Returns JSON list of suggestions (India only)
// ════════════════════════════════════════════════════════════════
async function handlePlacesProxy(request, url, env) {
  // CORS preflight
  if (request.method === 'OPTIONS') return corsPrelight();

  const input = url.searchParams.get('input') || '';
  const sessionToken = url.searchParams.get('sessiontoken') || '';

  if (!input || input.length < 2) {
    return jsonResponse({ predictions: [], status: 'ZERO_RESULTS' });
  }

  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: 'API key not configured' }, 500);
  }

  const googleUrl = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
  googleUrl.searchParams.set('input', input);
  googleUrl.searchParams.set('key', apiKey);
  googleUrl.searchParams.set('components', 'country:in');   // India only
  googleUrl.searchParams.set('types', '(cities)');
  googleUrl.searchParams.set('language', 'en');
  if (sessionToken) googleUrl.searchParams.set('sessiontoken', sessionToken);

  try {
    const res = await fetch(googleUrl.toString());
    const data = await res.json();

    // Strip any sensitive fields before forwarding to browser
    const safe = {
      status: data.status,
      predictions: (data.predictions || []).map(p => ({
        place_id:     p.place_id,
        description:  p.description,
        main_text:    p.structured_formatting?.main_text,
        secondary_text: p.structured_formatting?.secondary_text,
        types:        p.types
      }))
    };

    return jsonResponse(safe, 200);
  } catch (err) {
    return jsonResponse({ error: 'Upstream error', detail: err.message }, 502);
  }
}

// ════════════════════════════════════════════════════════════════
//  Place Details Proxy
//  GET /api/place-details?place_id=ChIJxxx&sessiontoken=abc123
//  Returns lat, lng, formatted_address for a place_id
// ════════════════════════════════════════════════════════════════
async function handlePlaceDetails(url, env) {
  const placeId = url.searchParams.get('place_id') || '';
  const sessionToken = url.searchParams.get('sessiontoken') || '';

  if (!placeId) {
    return jsonResponse({ error: 'place_id is required' }, 400);
  }

  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: 'API key not configured' }, 500);
  }

  const googleUrl = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  googleUrl.searchParams.set('place_id', placeId);
  googleUrl.searchParams.set('key', apiKey);
  googleUrl.searchParams.set('fields', 'name,formatted_address,geometry');
  googleUrl.searchParams.set('language', 'en');
  if (sessionToken) googleUrl.searchParams.set('sessiontoken', sessionToken);

  try {
    const res = await fetch(googleUrl.toString());
    const data = await res.json();

    if (data.status !== 'OK') {
      return jsonResponse({ error: data.status }, 400);
    }

    const r = data.result;
    return jsonResponse({
      name:    r.name,
      address: r.formatted_address,
      lat:     r.geometry?.location?.lat,
      lng:     r.geometry?.location?.lng
    });
  } catch (err) {
    return jsonResponse({ error: 'Upstream error', detail: err.message }, 502);
  }
}

// ════════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════════
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    }
  });
}

function corsPrelight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}
