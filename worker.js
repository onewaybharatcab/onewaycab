/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║       One-Way Bhaarat — Cloudflare Worker                   ║
 * ║                                                              ║
 * ║  Serves all HTML pages with secrets injected server-side.   ║
 * ║  Google API key is NEVER visible in browser source code.    ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Secrets/Variables (Cloudflare Dashboard → Settings → Variables):
 *   GOOGLE_PLACES_API_KEY  ← Secret
 *   SITE_ENV               ← Variable
 *   SITE_NAME              ← Variable
 *   SITE_URL               ← Variable
 */

// ── Import all HTML pages from root folder ───────────────────────
import INDEX_HTML    from './index.html';
import BOOKING_HTML  from './booking.html';
import ABOUT_HTML    from './about.html';
import ADMIN_HTML    from './admin.html';
import BLOG_HTML     from './blog.html';
import CONTACT_HTML  from './contact.html';
import CUSTOMER_HTML from './customer.html';
import DRIVER_HTML   from './driver.html';
import FAQ_HTML      from './faq.html';
import FLEET_HTML    from './fleet.html';
import POLICIES_HTML from './policies.html';
import ROUTES_HTML   from './routes.html';

// ── HTML page map ────────────────────────────────────────────────
const PAGES = {
  '/':               INDEX_HTML,
  '/index.html':     INDEX_HTML,
  '/booking.html':   BOOKING_HTML,
  '/about.html':     ABOUT_HTML,
  '/admin.html':     ADMIN_HTML,
  '/blog.html':      BLOG_HTML,
  '/contact.html':   CONTACT_HTML,
  '/customer.html':  CUSTOMER_HTML,
  '/driver.html':    DRIVER_HTML,
  '/faq.html':       FAQ_HTML,
  '/fleet.html':     FLEET_HTML,
  '/policies.html':  POLICIES_HTML,
  '/routes.html':    ROUTES_HTML,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── API: Places Autocomplete proxy ──────────────────────────
    if (url.pathname === '/api/places') {
      return handlePlacesProxy(request, url, env);
    }

    // ── API: Place Details proxy ─────────────────────────────────
    if (url.pathname === '/api/place-details') {
      return handlePlaceDetails(url, env);
    }

    // ── Serve HTML page ──────────────────────────────────────────
    const html = PAGES[url.pathname];
    if (html) {
      return serveHTML(html, env);
    }

    // ── 404 ──────────────────────────────────────────────────────
    return new Response('Page not found', { status: 404 });
  }
};

// ════════════════════════════════════════════════════════════════
//  Serve HTML — inject API key token at request time
// ════════════════════════════════════════════════════════════════
function serveHTML(html, env) {
  const apiKey = env.GOOGLE_PLACES_API_KEY || '';
  const finalHTML = html.replace('__GOOGLE_PLACES_API_KEY__', apiKey);

  return new Response(finalHTML, {
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cache-Control': 'public, max-age=300',
    }
  });
}

// ════════════════════════════════════════════════════════════════
//  Places Autocomplete Proxy
//  GET /api/places?input=Delhi&sessiontoken=abc
// ════════════════════════════════════════════════════════════════
async function handlePlacesProxy(request, url, env) {
  if (request.method === 'OPTIONS') return corsPreflight();

  const input        = url.searchParams.get('input') || '';
  const sessionToken = url.searchParams.get('sessiontoken') || '';

  if (!input || input.length < 2) {
    return jsonResponse({ predictions: [], status: 'ZERO_RESULTS' });
  }

  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return jsonResponse({ error: 'API key not configured' }, 500);

  const gUrl = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
  gUrl.searchParams.set('input', input);
  gUrl.searchParams.set('key', apiKey);
  gUrl.searchParams.set('components', 'country:in');
  gUrl.searchParams.set('types', '(cities)');
  gUrl.searchParams.set('language', 'en');
  if (sessionToken) gUrl.searchParams.set('sessiontoken', sessionToken);

  try {
    const res  = await fetch(gUrl.toString());
    const data = await res.json();

    // Strip sensitive fields — only forward what the frontend needs
    const safe = {
      status: data.status,
      predictions: (data.predictions || []).map(p => ({
        place_id:       p.place_id,
        description:    p.description,
        main_text:      p.structured_formatting?.main_text,
        secondary_text: p.structured_formatting?.secondary_text,
        types:          p.types
      }))
    };
    return jsonResponse(safe);
  } catch (err) {
    return jsonResponse({ error: 'Upstream error', detail: err.message }, 502);
  }
}

// ════════════════════════════════════════════════════════════════
//  Place Details Proxy
//  GET /api/place-details?place_id=ChIJxxx&sessiontoken=abc
// ════════════════════════════════════════════════════════════════
async function handlePlaceDetails(url, env) {
  const placeId      = url.searchParams.get('place_id') || '';
  const sessionToken = url.searchParams.get('sessiontoken') || '';

  if (!placeId) return jsonResponse({ error: 'place_id required' }, 400);

  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return jsonResponse({ error: 'API key not configured' }, 500);

  const gUrl = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  gUrl.searchParams.set('place_id', placeId);
  gUrl.searchParams.set('key', apiKey);
  gUrl.searchParams.set('fields', 'name,formatted_address,geometry');
  gUrl.searchParams.set('language', 'en');
  if (sessionToken) gUrl.searchParams.set('sessiontoken', sessionToken);

  try {
    const res  = await fetch(gUrl.toString());
    const data = await res.json();

    if (data.status !== 'OK') return jsonResponse({ error: data.status }, 400);

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

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}
