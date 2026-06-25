// ── Loader dismiss is handled by inline <script> in <head> of index.html ──
// (kept here as fallback for other pages that don't have the inline script)
(function(){
  if(window._loaderStart) return; // already handled inline
  var el=document.getElementById('loader');
  if(el) setTimeout(function(){ el.classList.add('out'); }, 1500);
})();

// ── Header scroll effect ──────────────────────────────
window.addEventListener('scroll', () => {
  const h = document.getElementById('header');
  if(h) h.classList.toggle('scrolled', window.scrollY > 60);
});

// ── Mobile hamburger menu ──────────────────────────────
function openMobMenu() {
  const btn     = document.getElementById('hamBtn');
  const drawer  = document.getElementById('mobDrawer');
  const overlay = document.getElementById('mobOverlay');
  if (!drawer) return;
  btn    && btn.classList.add('open');
  btn    && btn.setAttribute('aria-expanded', 'true');
  drawer .classList.add('open');
  overlay && (overlay.style.display = 'block');
  requestAnimationFrame(() => overlay && overlay.classList.add('open'));
  document.body.style.overflow = 'hidden'; // prevent background scroll
}

function closeMobMenu() {
  const btn     = document.getElementById('hamBtn');
  const drawer  = document.getElementById('mobDrawer');
  const overlay = document.getElementById('mobOverlay');
  if (!drawer) return;
  btn    && btn.classList.remove('open');
  btn    && btn.setAttribute('aria-expanded', 'false');
  drawer .classList.remove('open');
  overlay && overlay.classList.remove('open');
  setTimeout(() => { if (overlay) overlay.style.display = 'none'; }, 300);
  document.body.style.overflow = '';
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('hamBtn');
  if (btn) btn.addEventListener('click', () => {
    btn.classList.contains('open') ? closeMobMenu() : openMobMenu();
  });
  // Close on Escape key
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeMobMenu();
  });
});

// ── Trip type (hero widget) ─────────────────────────────────────────────────
let _heroTripType = 'oneway'; // tracks hero widget trip selection
function setTrip(el, type) {
  _heroTripType = type;
  document.querySelectorAll('.trip-tab').forEach(t => {
    t.classList.remove('active');
    t.setAttribute('aria-pressed', 'false');
  });
  el.classList.add('active');
  el.setAttribute('aria-pressed', 'true');
  const row = document.getElementById('returnRow');
  if(row) row.style.display = type === 'roundtrip' ? 'block' : 'none';
}

// ── Swap ───────────────────────────────────────────────
function swapLocs() {
  const a = document.getElementById('pickup'), b = document.getElementById('drop');
  if(a && b) [a.value, b.value] = [b.value, a.value];
}

// ── Search — opens modal, pre-fills from hero widget ──
function searchCabs() {
  const pickupInput = document.getElementById('pickup');
  const dropInput   = document.getElementById('drop');
  if(!pickupInput || !dropInput) return;
  const p = pickupInput.value.trim();
  const d = dropInput.value.trim();
  pickupInput.style.borderColor = '';
  dropInput.style.borderColor   = '';
  let hasError = false;
  if (!p) { pickupInput.style.borderColor = 'rgba(244,123,0,.7)'; pickupInput.focus(); hasError = true; }
  if (!d) { dropInput.style.borderColor   = 'rgba(244,123,0,.7)'; if (!hasError) dropInput.focus(); hasError = true; }
  if (hasError) {
    let msg = document.getElementById('search-error-msg');
    if (!msg) {
      msg = document.createElement('p');
      msg.id = 'search-error-msg';
      msg.className = 'u-error-msg';
      const btn = document.querySelector('.search-btn');
      if(btn) btn.insertAdjacentElement('afterend', msg);
    }
    msg.textContent = (!p && !d) ? 'Please enter both pickup and drop locations.'
                    : !p ? 'Please enter a pickup location.'
                    : 'Please enter a drop location.';
    return;
  }
  const msg = document.getElementById('search-error-msg');
  if (msg) msg.remove();

  const pdateEl = document.getElementById('pdate');
  const ptimeEl = document.getElementById('ptime');
  const pickupDate = pdateEl ? pdateEl.value : '';
  const pickupTime = ptimeEl ? ptimeEl.value : '';
  if (pickupDate && pickupTime) {
    const pickupDT = new Date(`${pickupDate}T${pickupTime}`);
    if (pickupDT < new Date(Date.now() + 60 * 60 * 1000)) {
      let errMsg = document.getElementById('search-error-msg');
      if (!errMsg) {
        errMsg = document.createElement('p');
        errMsg.id = 'search-error-msg';
        errMsg.className = 'u-error-msg';
        const btn = document.querySelector('.search-btn');
        if(btn) btn.insertAdjacentElement('afterend', errMsg);
      }
      errMsg.textContent = 'Pickup time must be at least 1 hour from now.';
      return;
    }
  }

  const retDateEl = document.getElementById('rdate');
  const retDate = retDateEl ? retDateEl.value : '';
  BKM.S.pu      = p;
  BKM.S.dr      = d;
  BKM.S.date    = pickupDate;
  BKM.S.time    = pickupTime;
  BKM.S.retdate = retDate;
  BKM.S.trip    = _heroTripType; // carry trip type from hero widget into modal
  if (pickupPlaceData && pickupPlaceData.lat) BKM._puData = pickupPlaceData;
  if (dropPlaceData   && dropPlaceData.lat)   BKM._drData = dropPlaceData;
  BKM._preDistKm = 0;
  bkmOpen({ prefill: true });
}

// ── Fare Calc ──────────────────────────────────────────
const RATES = {
  sedan_ow:16,ertiga_ow:21,innova_ow:30,tempo_ow:42,
  sedan_rt:12,ertiga_rt:15,innova_rt:20,tempo_rt:35
};
function calcDistInput(input) {
  const errEl = document.getElementById('calcDistError');
  const raw = input.value;
  const cleaned = raw.replace(/[^0-9]/g, '');
  if (cleaned !== raw) {
    input.value = cleaned;
    if (raw.length > 0 && errEl) {
      errEl.textContent = '⚠️ Only numbers allowed. Please enter distance in km.';
      errEl.style.display = 'block';
      setTimeout(() => { errEl.style.display = 'none'; }, 2500);
    }
  } else {
    if(errEl) errEl.style.display = 'none';
  }
  calcFare();
}

function calcFare() {
  const vEl = document.getElementById('calcVehicle');
  const dEl = document.getElementById('calcDist');
  const panel = document.getElementById('calcResult');
  const errEl = document.getElementById('calcDistError');
  if(!vEl || !dEl || !panel) return;
  const v = vEl.value;
  const d = parseFloat(dEl.value.trim()) || 0;

  if (d < 1) { panel.classList.remove('show'); return; }
  if (d > 3000) {
    if(errEl){ errEl.textContent = '⚠️ Distance must be between 1 and 3000 km.'; errEl.style.display = 'block'; }
    panel.classList.remove('show');
    return;
  }
  if(errEl) errEl.style.display = 'none';

  const r = RATES[v], base = d * r, driver = d > 300 ? 400 : 200;
  const tax = Math.round(base * 0.05), gst = Math.round(base * 0.05);
  const toll = Math.round(d / 50) * 30, total = Math.round(base + driver + tax + gst + toll);
  const adv = Math.round(total * 0.1);
  const fmt = n => '₹' + n.toLocaleString('en-IN');
  const set = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val; };
  set('r_base_lbl', `Base Fare (${d} km × ₹${r})`);
  set('r_base', fmt(base)); set('r_driver', fmt(driver));
  set('r_tax', fmt(tax)); set('r_gst', fmt(gst));
  set('r_toll', fmt(toll) + ' (approx)'); set('r_total', fmt(total));
  set('r_advance', fmt(adv)); set('r_remaining', fmt(total - adv));
  panel.classList.add('show');
}

// ── Routes ─────────────────────────────────────────────
const ROUTES = [
  {from:'Delhi',to:'Jaipur',d:281,icon:'🏯',p:4800},{from:'Delhi',to:'Agra',d:233,icon:'🕌',p:3900},
  {from:'Delhi',to:'Chandigarh',d:248,icon:'🌿',p:4200},{from:'Delhi',to:'Haridwar',d:214,icon:'🕍',p:3700},
  {from:'Delhi',to:'Shimla',d:342,icon:'❄️',p:6000},{from:'Delhi',to:'Manali',d:570,icon:'🏔️',p:9500},
  {from:'Mumbai',to:'Pune',d:155,icon:'🏙️',p:2800},{from:'Mumbai',to:'Goa',d:590,icon:'🏖️',p:9800},
  {from:'Mumbai',to:'Nashik',d:170,icon:'🍇',p:3000},{from:'Mumbai',to:'Shirdi',d:242,icon:'🙏',p:4200},
  {from:'Bangalore',to:'Mysore',d:143,icon:'🏰',p:2500},{from:'Bangalore',to:'Coorg',d:246,icon:'☕',p:4200},
  {from:'Bangalore',to:'Ooty',d:268,icon:'🌿',p:4600},{from:'Chennai',to:'Pondicherry',d:162,icon:'🏛️',p:2800},
  {from:'Chennai',to:'Tirupati',d:130,icon:'🛕',p:2300},{from:'Hyderabad',to:'Vijayawada',d:275,icon:'🌊',p:4700},
  {from:'Jaipur',to:'Jodhpur',d:335,icon:'🏯',p:5700},{from:'Jaipur',to:'Udaipur',d:421,icon:'🏰',p:7100},
  {from:'Lucknow',to:'Varanasi',d:320,icon:'🙏',p:5400},{from:'Ahmedabad',to:'Udaipur',d:262,icon:'💫',p:4500},
  {from:'Kochi',to:'Munnar',d:130,icon:'☕',p:2400},{from:'Trivandrum',to:'Kochi',d:217,icon:'🌴',p:3800},
  {from:'Kolkata',to:'Darjeeling',d:590,icon:'🍵',p:9800},{from:'Bhubaneswar',to:'Puri',d:64,icon:'🛕',p:1400},
];

// ── Scroll reveal ──────────────────────────────────────
const ro = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
}, { threshold: 0.08 });

// ══════════════════════════════════════════════════════════════
//  LOCATION AUTOCOMPLETE
// ══════════════════════════════════════════════════════════════
let pickupPlaceData = {}, dropPlaceData = {};
const IS_LOCAL = location.protocol === 'file:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

function newSessionToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
let sessionToken = newSessionToken();

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function renderDropdown(listEl, predictions, onPick) {
  listEl.innerHTML = '';
  if (!predictions.length) return;
  predictions.forEach(p => {
    const item = document.createElement('div');
    item.className = 'autocomplete-item';
    const icon = document.createElement('span');
    icon.className = 'ac-icon'; icon.textContent = '📍';
    const textWrap = document.createElement('span');
    const main = document.createElement('div'); main.className = 'ac-main';
    main.textContent = p.main_text || p.description || '';
    const sub = document.createElement('div'); sub.className = 'ac-sub';
    sub.textContent = p.secondary_text || '';
    textWrap.appendChild(main); textWrap.appendChild(sub);
    item.appendChild(icon); item.appendChild(textWrap);
    item.addEventListener('mousedown', e => { e.preventDefault(); onPick(p); listEl.innerHTML = ''; });
    listEl.appendChild(item);
  });
}

async function fetchPredictionsProxy(query) {
  const res = await fetch(`/api/places?input=${encodeURIComponent(query)}&sessiontoken=${sessionToken}`);
  const data = await res.json();
  return data.predictions || [];
}

async function fetchDetailsProxy(placeId) {
  const res = await fetch(`/api/place-details?place_id=${placeId}&sessiontoken=${sessionToken}`);
  const data = await res.json();
  const loc = data?.result?.geometry?.location;
  return {
    name:    data?.result?.name || '',
    address: data?.result?.formatted_address || '',
    lat:     loc?.lat ?? null,
    lng:     loc?.lng ?? null
  };
}

let _sdkService = null;
function getSDKService() {
  if (!_sdkService && window.google) _sdkService = new google.maps.places.AutocompleteService();
  return _sdkService;
}

function fetchPredictionsSDK(query) {
  return new Promise((resolve) => {
    const svc = getSDKService();
    if (!svc) return resolve([]);
    svc.getPlacePredictions(
      { input: query, componentRestrictions: { country: 'in' }, types: ['(cities)'] },
      (preds, status) => {
        if (status !== google.maps.places.PlacesServiceStatus.OK || !preds) return resolve([]);
        resolve(preds.map(p => ({
          place_id:       p.place_id,
          description:    p.description,
          main_text:      p.structured_formatting?.main_text,
          secondary_text: p.structured_formatting?.secondary_text
        })));
      }
    );
  });
}

function fetchDetailsSDK(placeId) {
  return new Promise((resolve) => {
    const dummy = document.createElement('div');
    const svc   = new google.maps.places.PlacesService(dummy);
    svc.getDetails(
      { placeId, fields: ['name', 'formatted_address', 'geometry'] },
      (place, status) => {
        if (status !== google.maps.places.PlacesServiceStatus.OK) return resolve({});
        resolve({
          name:    place.name,
          address: place.formatted_address,
          lat:     place.geometry.location.lat(),
          lng:     place.geometry.location.lng()
        });
      }
    );
  });
}

function attachAutocomplete(inputId, listId, onSelect) {
  const input  = document.getElementById(inputId);
  const listEl = document.getElementById(listId);
  if(!input || !listEl) return;
  const suggest = debounce(async (query) => {
    if (query.length < 2) { listEl.innerHTML = ''; return; }
    try {
      const preds = IS_LOCAL ? await fetchPredictionsSDK(query) : await fetchPredictionsProxy(query);
      renderDropdown(listEl, preds, async (p) => {
        input.value = p.main_text || p.description;
        input.style.borderColor = '';
        try {
          const detail = IS_LOCAL ? await fetchDetailsSDK(p.place_id) : await fetchDetailsProxy(p.place_id);
          onSelect({ ...detail, place_id: p.place_id });
          sessionToken = newSessionToken();
        } catch(e) { console.warn('Place detail error', e); }
      });
    } catch(e) { console.warn('Autocomplete error', e); }
  }, 280);
  input.addEventListener('input', () => suggest(input.value.trim()));
  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !listEl.contains(e.target)) listEl.innerHTML = '';
  });
}

function initAutocomplete() {
  attachAutocomplete('pickup', 'pickup-list', d => { pickupPlaceData = d; });
  attachAutocomplete('drop',   'drop-list',   d => { dropPlaceData   = d; });
  const banner = document.getElementById('api-key-banner');
  if (banner) banner.style.display = 'none';
}

// ══════════════════════════════════════════════════════════════
//  BOOKING MODAL — 5-Step Flow
// ══════════════════════════════════════════════════════════════
const ADMIN_WA = '919355757579';

const BKM_VEHICLES = [
  {key:'sedan',  name:'Sedan',           sub:'Swift Dzire / Honda Amaze / Aspire', icon:'🚗', seats:4,  badge:'Popular',  ow:16, rt:12, minFare:1500},
  {key:'ertiga', name:'Ertiga',          sub:'Maruti Ertiga / XL6 (6-Seater)',     icon:'🚐', seats:6,  badge:'Family',   ow:21, rt:15, minFare:1700},
  {key:'innova', name:'Innova Crysta',   sub:'Toyota Innova Crysta',               icon:'🚙', seats:7,  badge:'Premium',  ow:30, rt:20, minFare:2000},
  {key:'tempo',  name:'Tempo Traveller', sub:'12-Seater Force / Mahindra',         icon:'🚌', seats:12, badge:'Group',    ow:42, rt:35, minFare:4000},
];

const BKM = {
  S: {
    trip:'oneway', pu:'', dr:'', date:'', time:'', retdate:'',
    rettime:'', pax:'3–4 Passengers',
    vehicle:null, vehicleName:'', rate:0, distKm:0,
    totalFare:0, advAmt:0, payMode:'partial', payAmt:0,
    name:'', phone:'', email:'', notes:'',
    bookingId:'', extraCities:[], step:1,
  },
  _step:1,
  _puData:{}, _drData:{},
  _preDistKm:0,
  _sessionToken: null,
};

let _toastTimer;
function bkmToast(msg, dur=3200){
  const el = document.getElementById('owb-toast');
  if(!el) return;
  el.textContent = msg; el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), dur);
}

function bkmOpen(opts={}){
  const modal = document.getElementById('bkModal');
  if(!modal) return;
  if(!opts.prefill){ _bkmReset(); }
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  _bkmGoStep(1);
  if(opts.prefill || BKM.S.pu){
    const puEl = document.getElementById('bk-pu');
    const drEl = document.getElementById('bk-dr');
    const dtEl = document.getElementById('bk-dt');
    const tmEl = document.getElementById('bk-tm');
    const retEl = document.getElementById('bk-ret');
    if(puEl && BKM.S.pu) puEl.value = BKM.S.pu;
    if(drEl && BKM.S.dr) drEl.value = BKM.S.dr;
    if(dtEl && BKM.S.date) dtEl.value = BKM.S.date;
    if(tmEl && BKM.S.time) tmEl.value = BKM.S.time;
    if(retEl && BKM.S.retdate) retEl.value = BKM.S.retdate;
    // Sync modal trip buttons to match hero widget selection
    if(BKM.S.trip) bkmSetTrip(BKM.S.trip);
    BKM.S.distKm = 0;
    const distEl = document.getElementById('bkm-dist');
    if(distEl) distEl.classList.remove('show');
    if(BKM._preDistKm > 0){
      BKM.S.distKm = BKM._preDistKm;
      _bkmShowDist(`~${BKM._preDistKm} km`);
    } else if(BKM.S.pu && BKM.S.dr){
      _bkmMaybeLiveDist();
    }
  }
  _bkmUpdateBtn();
}

function bkmClose(){
  const modal = document.getElementById('bkModal');
  if(modal) modal.classList.remove('open');
  document.body.style.overflow = '';
  _bkmHidePortal();
}

function _bkmReset(){
  const S = BKM.S;
  S.trip='oneway'; S.pu=''; S.dr=''; S.date=''; S.time='';
  S.retdate=''; S.rettime=''; S.pax='3–4 Passengers';
  S.vehicle=null; S.vehicleName=''; S.rate=0; S.distKm=0;
  S.totalFare=0; S.advAmt=0; S.payMode='partial'; S.payAmt=0;
  S.name=''; S.phone=''; S.email=''; S.notes='';
  S.bookingId=''; S.extraCities=[];
  BKM._preDistKm=0; BKM._puData={}; BKM._drData={};
  ['bk-pu','bk-dr','bk-dt','bk-tm','bk-ret','bk-ret-tm','bk-pn','bk-ph','bk-em','bk-notes']
    .forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  const distEl = document.getElementById('bkm-dist');
  if(distEl) distEl.classList.remove('show');
  const stopList = document.getElementById('bkm-stop-list');
  if(stopList) stopList.innerHTML='';
  bkmSetTrip('oneway');
}

function _bkmGoStep(n){
  BKM._step = n;
  [1,2,3,4,5].forEach(i => {
    const s = document.getElementById('bkmS'+i);
    if(s) s.style.display = (i===n ? '' : 'none');
    const p = document.getElementById('bkmp'+i);
    if(p){
      p.classList.remove('active','done');
      if(i < n) p.classList.add('done');
      else if(i === n) p.classList.add('active');
    }
  });
  const foot = document.getElementById('bkmFoot');
  if(foot) foot.style.display = n===5 ? 'none' : '';
  _bkmUpdateBtn();
}

function _bkmUpdateBtn(){
  const next = document.getElementById('bkmBtnNext');
  const back = document.getElementById('bkmBtnBack');
  const n = BKM._step;
  if(next){
    next.textContent = n===1 ? 'Search Cabs →' : n===3 ? 'Send OTP →' : 'Verify OTP →';
    next.style.display = n===2 ? 'none' : '';
  }
  if(back) back.style.display = n>1 ? '' : 'none';
}

function bkmNext(){
  const n = BKM._step;
  if(n===1) _bkmStep1Next();
  else if(n===2) _bkmStep2Next();
  else if(n===3) _bkmStep3Next();
  else if(n===4) _bkmVerifyOTP();
}

function bkmBack(){
  if(BKM._step > 1) _bkmGoStep(BKM._step-1);
}

function bkmSetTrip(t){
  BKM.S.trip = t;
  ['oneway','roundtrip'].forEach(k => {
    const el = document.getElementById('bktt-'+k);
    if(el) el.classList.toggle('on', k===t);
  });
  const retWrap = document.getElementById('bkm-ret-wrap');
  if(retWrap) retWrap.style.display = t==='roundtrip' ? '' : 'none';
  const stopsBlock = document.getElementById('bkm-stops-block');
  if(stopsBlock) stopsBlock.style.display = t==='roundtrip' ? '' : 'none';
  if(t==='oneway'){
    BKM.S.extraCities=[];
    const stopList = document.getElementById('bkm-stop-list');
    if(stopList) stopList.innerHTML='';
  }
  if(BKM.S.distKm > 0) _bkmRenderLiveFares();
  _bkmSyncRTDrop(t);
}

function _bkmSyncRTDrop(t){
  const drEl    = document.getElementById('bk-dr');
  const drLabel = document.getElementById('bk-dr-label');
  const puEl    = document.getElementById('bk-pu');
  if(!drEl) return;
  if(t==='roundtrip'){
    drEl.value    = puEl ? puEl.value : '';
    drEl.readOnly = true;
    drEl.classList.add('u-drop-locked');
    if(drLabel) drLabel.innerHTML = '🔄 Return To <span style="font-size:.62rem;color:var(--sf-400);font-weight:700">(same as pickup)</span>';
  } else {
    drEl.readOnly = false;
    drEl.classList.remove('u-drop-locked');
    drEl.style.background=''; drEl.style.color=''; drEl.style.cursor=''; drEl.style.borderColor='';
    drEl.value = '';
    BKM.S.dr = ''; BKM.S.distKm = 0; BKM._preDistKm = 0;
    const distEl = document.getElementById('bkm-dist');
    if(distEl) distEl.classList.remove('show');
    const lf = document.getElementById('bkmLiveFares');
    if(lf) lf.classList.remove('show');
    if(drLabel) drLabel.textContent = '🏁 To Location *';
  }
}

function _bkmShowDist(txt){
  const el = document.getElementById('bkm-dist');
  const tx = document.getElementById('bkm-dist-txt');
  if(el && tx){ tx.textContent=txt; el.classList.add('show'); }
  if(BKM.S.distKm > 0) _bkmRenderLiveFares();
}

function _bkmRenderLiveFares(){
  const km = BKM.S.distKm || 0;
  const isRound = BKM.S.trip === 'roundtrip';
  const panel = document.getElementById('bkmLiveFares');
  const rows  = document.getElementById('bkmLiveFareRows');
  const title = panel ? panel.querySelector('.bkm-lf-title') : null;
  if(!panel || !rows || km < 1) return;
  if(title) title.textContent = isRound ? '🔄 ROUND TRIP RATES' : '🚕 ONE WAY RATES';
  rows.innerHTML = BKM_VEHICLES.map(v => {
    let fare;
    if(isRound){
      const days = _bkmCalcDays();
      const packageKm = 250 * days;
      const billedKm = Math.max(km, packageKm);
      fare = Math.ceil(billedKm * v.rt) + (days * 300);
    } else {
      const perKm = Math.ceil(km * v.ow);
      fare = km < 100 ? Math.max(perKm, v.minFare) : perKm;
    }
    const hasExtra = isRound && Math.max(km, 250*_bkmCalcDays()) > 1000;
    return `<div class="bkm-lf-row" onclick="_bkmPreSelectVehicle('${v.key}')">
      <div class="bkm-lf-left">
        <span class="bkm-lf-icon">${v.icon}</span>
        <div>
          <div class="bkm-lf-name">${v.name}</div>
          <div class="bkm-lf-sub">${v.sub}</div>
        </div>
      </div>
      <div class="bkm-lf-price">₹${fare.toLocaleString('en-IN')}${hasExtra?'<span style="font-size:.6rem;color:#c85a00;display:block">⚠️ >1000 km</span>':''}</div>
    </div>`;
  }).join('');
  panel.classList.add('show');
}

function _bkmPreSelectVehicle(key){
  BKM._preSelectedVehicle = key;
}

async function _bkmFetchDist(origin, destination, _isRetry){
  if (!origin || !destination || origin === 'null,null' || destination === 'null,null') {
    _bkmShowDist('Route distance unavailable');
    return null;
  }
  try {
    const res = await fetch(`/api/distance?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`);
    const d   = await res.json();
    if(d && d.distanceKm){
      BKM.S.distKm = d.distanceKm;
      const label = d.durationText ? `${d.distanceKm} km · ~${d.durationText}` : `${d.distanceKm} km`;
      _bkmShowDist(label);
      return true;
    } else if(!_isRetry){
      return _bkmFetchDist(origin, destination, true);
    } else {
      _bkmDistFallback(); return false;
    }
  } catch(e){
    if(!_isRetry) return _bkmFetchDist(origin, destination, true);
    _bkmDistFallback(); return false;
  }
}

function _bkmDistFallback(){
  BKM.S.distKm = 0;
  _bkmShowDist(`Distance unavailable — we'll confirm by phone`);
}

async function _bkmFetchDistMultiStop(waypoints){
  _bkmShowDist('Calculating…');
  try {
    let total = 0;
    for(let i=0; i<waypoints.length-1; i++){
      const res = await fetch(`/api/distance?origin=${encodeURIComponent(waypoints[i])}&destination=${encodeURIComponent(waypoints[i+1])}`);
      const d   = await res.json();
      if(d && d.distanceKm) total += d.distanceKm;
      else throw new Error('leg '+i+' failed');
    }
    BKM.S.distKm = total;
    const isRt = BKM.S.trip === 'roundtrip';
    const numStops = isRt ? waypoints.length - 3 : waypoints.length - 2; // exclude pu at end for RT
    const label = isRt
      ? (numStops > 0 ? `~${total} km · round trip via ${numStops} stop${numStops>1?'s':''}` : `~${total} km · full round trip`)
      : `~${total} km via ${waypoints.length-2} stop(s)`;
    _bkmShowDist(label);
  } catch(e){ _bkmDistFallback(); }
}

async function _bkmStep1Next(){
  const pu = (document.getElementById('bk-pu')||{}).value?.trim();
  const dr = (document.getElementById('bk-dr')||{}).value?.trim();
  const dt = (document.getElementById('bk-dt')||{}).value;
  const tm = (document.getElementById('bk-tm')||{}).value;
  const ret= document.getElementById('bk-ret')?.value || '';
  let ok = true;
  ['bkfg-pu','bkfg-dr','bkfg-dt'].forEach(id => document.getElementById(id)?.classList.remove('err'));
  if(!pu){ document.getElementById('bkfg-pu')?.classList.add('err'); ok=false; }
  if(!dr){ document.getElementById('bkfg-dr')?.classList.add('err'); ok=false; }
  if(!dt){ document.getElementById('bkfg-dt')?.classList.add('err'); ok=false; }
  if(!ok){ bkmToast('⚠️ Please fill all required fields'); return; }
  if(BKM.S.trip==='roundtrip' && !ret){ bkmToast('⚠️ Please select a return date'); return; }
  if(tm){
    const pickupDT = new Date(`${dt}T${tm}`);
    if(pickupDT < new Date(Date.now() + 60*60*1000)){ bkmToast('⚠️ Pickup time must be at least 1 hour from now'); return; }
  }
  BKM.S.pu = pu; BKM.S.dr = dr; BKM.S.date = dt; BKM.S.time = tm;
  BKM.S.retdate = ret;
  BKM.S.rettime = document.getElementById('bk-ret-tm')?.value || '';
  BKM.S.pax = (document.getElementById('bk-pax')||{}).value || '3–4 Passengers';
  if(!BKM.S.distKm || BKM.S.distKm === 0){
    const isRound = BKM.S.trip === 'roundtrip';
    const stops = (BKM.S.extraCities||[]).filter(c=>c.trim());
    // Round trip: append pickup at end so return leg is included in total distance
    const waypoints = isRound ? [pu, ...stops, dr, pu] : [pu, ...stops, dr];
    if(waypoints.length > 2){ await _bkmFetchDistMultiStop(waypoints); }
    else { await _bkmFetchDist(pu, dr); }
  }
  if(!BKM.S.distKm || BKM.S.distKm === 0){
    bkmToast('⚠️ Could not calculate route distance. Please check locations and try again.');
    _bkmShowDist('Distance unavailable — please retry');
    return;
  }
  _bkmGoStep(2);
  _bkmBuildCabs();
}

function _bkmBuildCabs(){
  const S = BKM.S;
  const isRound = S.trip==='roundtrip';
  const km = S.distKm || 50;
  const set = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val; };
  set('bkrs-pu', S.pu); set('bkrs-dr', S.dr);
  set('bkrs-date', S.date + (S.time ? ' at '+_bkmFmtTime(S.time) : ''));
  set('bkrs-type', isRound ? 'Round Trip' : 'One Way');
  let kmLabel = `~${km} km`;
  if(isRound){
    const days=_bkmCalcDays();
    const packageKm=250*days;
    const billedKm=Math.max(km,packageKm);
    const extraKm=billedKm>1000?billedKm-1000:0;
    kmLabel=`~${km} km actual · ${billedKm>km?`Min ${packageKm} km billed (${days}×250)`:`${billedKm} km billed`} · +₹${days*300} driver allowance`
           +(extraKm>0?` · ⚠️ ${extraKm} km >1000 km`:'');
  }
  set('bkrs-km', kmLabel);
  const cabList = document.getElementById('bkmCabList');
  if(cabList) cabList.innerHTML = BKM_VEHICLES.map((v,i) => {
    const days=_bkmCalcDays();
    let fare, billedKm, isMin=false, extraKm=0;
    if(isRound){
      const packageKm = 250 * days;          // minimum guaranteed km
      billedKm = Math.max(km, packageKm);    // always bill at least packageKm
      const driverAllow = days * 300;
      fare = Math.ceil(billedKm * v.rt) + driverAllow;
      // Extra km surcharge: if actual route > 1000 km, note it (already included in billedKm fare)
      if(billedKm > 1000) extraKm = billedKm - 1000;
    } else {
      const perKm=Math.ceil(km*v.ow); const base=km<100?Math.max(perKm,v.minFare):perKm;
      const stops=(S.extraCities||[]).filter(c=>c.trim()).length;
      fare=stops?Math.ceil(base*(1+0.15*stops)):base;
      billedKm=km;
      isMin=km<100&&fare===v.minFare;
    }
    const adv=Math.ceil(fare*0.10/10)*10; const rate=isRound?v.rt:v.ow;
    const driverAllow=isRound?(days*300):0;
    const packageKm=isRound?250*days:0;
    const usingMin=isRound&&km<packageKm; // actual route < minimum, so minimum applies
    return `<div class="bkm-cab ${isRound?'bkm-cab-rt':''}" id="bkc-${v.key}" onclick="_bkmSelectCab('${v.key}','${v.name.replace(/'/g,"\\'")}',${rate},${fare},${adv})" style="animation:bkmIn .3s ${i*.07}s ease both">
      <div class="bkm-cab-top">
        <div class="bkm-cab-icon">${v.icon}</div>
        <div class="bkm-cab-info">
          <div class="bkm-cab-name">${v.name}<span class="bkm-cab-badge">${v.badge}</span></div>
          <div class="bkm-cab-sub">${v.sub}</div>
          <div class="bkm-cab-specs">
            <span class="bkm-cab-spec">👥 ${v.seats} Seats</span>
            <span class="bkm-cab-spec">❄️ AC</span>
            <span class="bkm-cab-spec">${isMin?'Min fare':'₹'+rate+'/km'}</span>
            ${isRound?`<span class="bkm-cab-spec">🔄 ${days} day${days>1?'s':''}</span>`:''}
          </div>
        </div>
        <div class="bkm-cab-fare">
          <div class="bkm-cab-total">₹${fare.toLocaleString('en-IN')}</div>
          <div class="bkm-cab-rate">${isMin?'Minimum fare':extraKm>0?'⚠️ Extra km applies':'Est. total'}</div>
          <div class="bkm-cab-adv">10% adv: ₹${adv}</div>
          <button type="button" class="bkm-cab-selbtn">SELECT</button>
        </div>
      </div>
      ${isRound?`<div class="bkm-rt-breakdown">
        <span>📏 ${usingMin
          ? `Actual ${km} km < min ${packageKm.toLocaleString('en-IN')} km (${days}×250) → billing ${packageKm.toLocaleString('en-IN')} km`
          : `Route ${km} km · billing ${billedKm.toLocaleString('en-IN')} km`
        }</span>
        <span>₹${rate}/km × ${billedKm.toLocaleString('en-IN')} km = ₹${Math.ceil(billedKm*rate).toLocaleString('en-IN')}</span>
        <span>🧑 Driver allowance: +₹${driverAllow.toLocaleString('en-IN')}</span>
        ${extraKm>0?`<span style="color:#c85a00;font-weight:800">⚠️ Route >1000 km: ${extraKm.toLocaleString('en-IN')} extra km × ₹${rate} already included</span>`:''}
      </div>`:''}
    </div>`;
  }).join('');
  if(BKM._preSelectedVehicle){
    const el=document.getElementById('bkc-'+BKM._preSelectedVehicle);
    if(el) el.click();
    BKM._preSelectedVehicle=null;
  }
}

function _bkmCalcDays(){
  const S=BKM.S;
  if(!S.date||!S.retdate) return 1;
  const d1=new Date(S.date),d2=new Date(S.retdate);
  const diff=Math.ceil((d2-d1)/(1000*60*60*24));
  return Math.max(1,diff);
}

function _bkmSelectCab(key,name,rate,fare,adv){
  document.querySelectorAll('.bkm-cab').forEach(c=>c.classList.remove('sel'));
  const el=document.getElementById('bkc-'+key);
  if(el) el.classList.add('sel');
  BKM.S.vehicle=key; BKM.S.vehicleName=name; BKM.S.rate=rate;
  BKM.S.totalFare=fare; BKM.S.advAmt=adv;
  bkmToast(`✓ ${name} selected — proceeding…`);
  setTimeout(() => _bkmGoStep(3), 600);
}

function _bkmStep2Next(){
  if(!BKM.S.vehicle){ bkmToast('⚠️ Please select a cab first'); return; }
  _bkmGoStep(3);
}

async function _bkmStep3Next(){
  const name  = (document.getElementById('bk-pn')||{}).value?.trim();
  const phone = (document.getElementById('bk-ph')||{}).value?.replace(/\D/g,'')||'';
  const email = (document.getElementById('bk-em')||{}).value?.trim();
  let ok=true;
  ['bkfg-pn','bkfg-ph','bkfg-em'].forEach(id=>document.getElementById(id)?.classList.remove('err'));
  if(!name)  { document.getElementById('bkfg-pn')?.classList.add('err'); ok=false; }
  if(phone.length!==10){ document.getElementById('bkfg-ph')?.classList.add('err'); ok=false; }
  if(!email||!email.includes('@')){ document.getElementById('bkfg-em')?.classList.add('err'); ok=false; }
  if(!ok){ bkmToast('⚠️ Please fill all required fields correctly'); return; }
  BKM.S.name=name; BKM.S.phone=phone; BKM.S.email=email;
  BKM.S.notes=(document.getElementById('bk-notes')||{}).value?.trim()||'';
  BKM.S.bookingId='OWB-'+Date.now().toString().slice(-6)+Math.random().toString(36).slice(2,4).toUpperCase();
  const btn=document.getElementById('bkmBtnNext');
  if(btn){ btn.textContent='Sending…'; btn.disabled=true; }
  try {
    const res=await fetch('/api/otp/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,name})});
    const data=await res.json();
    if(data.success){
      bkmToast('📱 OTP sent via WhatsApp to +91 '+phone);
      const otpNum=document.getElementById('bk-otp-num');
      if(otpNum) otpNum.textContent='+91 '+phone;
      ['bo1','bo2','bo3','bo4','bo5','bo6'].forEach(id=>{const el=document.getElementById(id);if(el){el.value='';el.classList.remove('filled');}});
      _bkmGoStep(4);
      _bkmStartOTPTimer();
      setTimeout(()=>{ const bo1=document.getElementById('bo1'); if(bo1) bo1.focus(); }, 100);
    } else {
      // Show the actual error from the server (WhatsApp error, rate limit, etc.)
      const errMsg = data.error || 'Please try again';
      bkmToast('⚠️ ' + errMsg);
      console.error('[OWB OTP] Send failed:', data);
    }
  } catch(e){ bkmToast('⚠️ Network error sending OTP: ' + e.message); console.error('[OWB OTP]', e); }
  if(btn){ btn.disabled=false; } _bkmUpdateBtn();
}

function _bkmStartOTPTimer(){
  let secs=30;
  const cd=document.getElementById('bkmCD');
  const btn=document.getElementById('bkmResend');
  if(btn){ btn.style.pointerEvents='none'; btn.style.opacity='.4'; btn.classList.remove('active'); }
  const iv=setInterval(()=>{
    secs--;
    if(cd) cd.textContent=secs;
    if(secs<=0){ clearInterval(iv); if(btn){ btn.style.pointerEvents='auto'; btn.style.opacity='1'; btn.classList.add('active'); } }
  },1000);
}

function bkmResendOTP(){ _bkmStep3Resend(); _bkmStartOTPTimer(); }
async function _bkmStep3Resend(){
  try{
    await fetch('/api/otp/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:BKM.S.phone,name:BKM.S.name})});
    bkmToast('📱 OTP resent to +91 '+BKM.S.phone);
  }catch(e){ bkmToast('⚠️ Could not resend OTP'); }
}

function bkmOtpMove(inp,nextId){
  if(inp.value.length>1) inp.value=inp.value.slice(-1);
  inp.classList.toggle('filled',inp.value.length>0);
  if(inp.value.length>=1&&nextId){ const n=document.getElementById(nextId); if(n) n.focus(); }
}
function bkmOtpBack(e,inp,prevId){
  if(e.key==='Backspace'&&!inp.value&&prevId) document.getElementById(prevId).focus();
}

async function _bkmVerifyOTP(){
  const entered=['bo1','bo2','bo3','bo4','bo5','bo6'].map(id=>(document.getElementById(id)||{}).value||'').join('');
  if(entered.length<6){ bkmToast('⚠️ Please enter the complete 6-digit OTP'); return; }
  const btn=document.getElementById('bkmBtnNext');
  if(btn){ btn.textContent='Verifying…'; btn.disabled=true; }
  try{
    const res=await fetch('/api/otp/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:BKM.S.phone,code:entered})});
    const data=await res.json();
    if(data.verified){
      BKM.S.verifyToken=data.token||'';
      bkmToast('✅ Verified! Please complete payment to confirm.');
      _bkmGoStep(5); _bkmBuildSummary(); _bkmInitPayPanel(); _bkmNotifyAdmin();
    } else {
      bkmToast('❌ '+(data.error||'Invalid OTP — please try again'));
      ['bo1','bo2','bo3','bo4','bo5','bo6'].forEach(id=>{const el=document.getElementById(id);if(el){el.value='';el.classList.remove('filled');}});
      const bo1=document.getElementById('bo1'); if(bo1) bo1.focus();
    }
  } catch(e){ bkmToast('⚠️ Network error verifying OTP'); }
  if(btn){ btn.disabled=false; } _bkmUpdateBtn();
}

function _bkmBuildSummary(){
  const S=BKM.S;
  const refEl=document.getElementById('bkRef'); if(refEl) refEl.textContent=S.bookingId;
  const stops=(S.extraCities||[]).filter(c=>c.trim());
  const sumEl=document.getElementById('bkmSumFinal');
  if(sumEl) sumEl.innerHTML=`
    <div class="bkm-row"><span class="bl">Passenger</span><span class="bv">${S.name} · +91 ${S.phone}</span></div>
    <div class="bkm-row"><span class="bl">Vehicle</span><span class="bv">${S.vehicleName}</span></div>
    <div class="bkm-row"><span class="bl">Trip</span><span class="bv">${S.trip==='roundtrip'?'Round Trip':'One Way'}${stops.length?' · '+stops.length+' stop(s)':''}</span></div>
    <div class="bkm-row"><span class="bl">Pickup</span><span class="bv">${S.pu}</span></div>
    ${stops.map((c,i)=>`<div class="bkm-row"><span class="bl">Stop ${i+1}</span><span class="bv">${c}</span></div>`).join('')}
    <div class="bkm-row"><span class="bl">Drop</span><span class="bv">${S.dr}</span></div>
    <div class="bkm-row"><span class="bl">Date & Time</span><span class="bv">${_bkmFmtDate(S.date)} at ${_bkmFmtTime(S.time)}</span></div>
    ${S.retdate?`<div class="bkm-row"><span class="bl">Return</span><span class="bv">${_bkmFmtDate(S.retdate)}</span></div>`:''}
    <div class="bkm-row"><span class="bl">Distance</span><span class="bv">~${S.distKm} km</span></div>
    <div class="bkm-row"><span class="bl">Est. Fare</span><span class="bv" style="color:var(--sf-400);font-size:1.02rem">₹${S.totalFare.toLocaleString('en-IN')}</span></div>
  `;
}

function _bkmInitPayPanel(){
  const S=BKM.S; const adv=S.advAmt;
  const set=(id,val)=>{const el=document.getElementById(id);if(el)el.textContent=val;};
  set('ppAdv10','₹'+adv.toLocaleString('en-IN'));
  set('ppFull','₹'+S.totalFare.toLocaleString('en-IN'));
  set('bkmMinLabel',adv.toLocaleString('en-IN'));
  bkmSelectPayOpt('partial');
}

function bkmSelectPayOpt(mode){
  BKM.S.payMode=mode;
  ['ppOpt10','ppOptCustom','ppOptFull'].forEach(id=>document.getElementById(id)?.classList.remove('on'));
  const customRow=document.getElementById('bkmCustomRow');
  const summary=document.getElementById('bkmPaySummary');
  if(mode==='partial'){
    document.getElementById('ppOpt10')?.classList.add('on');
    if(customRow) customRow.style.display='none';
    BKM.S.payAmt=BKM.S.advAmt;
    if(summary) summary.textContent=`Pay ₹${BKM.S.advAmt.toLocaleString('en-IN')} now. Remaining ₹${(BKM.S.totalFare-BKM.S.advAmt).toLocaleString('en-IN')} to driver.`;
  } else if(mode==='custom'){
    document.getElementById('ppOptCustom')?.classList.add('on');
    if(customRow){ customRow.style.display='block'; const ci=document.getElementById('bkmCustomAmt'); if(ci){ ci.focus(); } }
    if(summary) summary.textContent='Enter any amount ≥ 10% advance.';
  } else {
    document.getElementById('ppOptFull')?.classList.add('on');
    if(customRow) customRow.style.display='none';
    BKM.S.payAmt=BKM.S.totalFare;
    if(summary) summary.textContent=`Full fare paid upfront. No balance due to driver.`;
  }
}

function bkmValidateCustom(){
  const inp=document.getElementById('bkmCustomAmt');
  const err=document.getElementById('bkmCustomErr');
  if(!inp) return;
  const v=parseFloat(inp.value)||0; const min=BKM.S.advAmt;
  if(v<min){
    if(err){ err.style.display='block'; err.textContent=`Minimum ₹${min.toLocaleString('en-IN')} (10% advance)`; }
    BKM.S.payAmt=0;
  } else {
    if(err) err.style.display='none';
    BKM.S.payAmt=v;
    const summary=document.getElementById('bkmPaySummary');
    if(summary) summary.textContent=`Pay ₹${v.toLocaleString('en-IN')} now. Balance ₹${(BKM.S.totalFare-v).toLocaleString('en-IN')} to driver.`;
  }
}

async function bkmTriggerRazorpay(){
  if(BKM.S.payMode==='custom'){
    const v=parseFloat((document.getElementById('bkmCustomAmt')||{}).value)||0;
    if(v<BKM.S.advAmt){ bkmToast('⚠️ Amount must be at least ₹'+BKM.S.advAmt.toLocaleString('en-IN')); return; }
    BKM.S.payAmt=v;
  }
  const amt=BKM.S.payAmt;
  if(!amt){ bkmToast('⚠️ Please select a payment amount'); return; }
  const statusEl=document.getElementById('bkmPayStatus');
  if(typeof Razorpay==='undefined'){
    bkmToast('⏳ Loading payment gateway, please wait…');
    if(statusEl){ statusEl.style.display='block'; statusEl.style.color='var(--sf-400)'; statusEl.textContent='Loading payment gateway…'; }
    let waited=0;
    const poll=setInterval(()=>{
      waited+=500;
      if(typeof Razorpay!=='undefined'){ clearInterval(poll); if(statusEl) statusEl.style.display='none'; bkmTriggerRazorpay(); }
      else if(waited>=12000){
        clearInterval(poll); bkmToast('⚠️ Payment gateway could not load.');
        if(statusEl){ statusEl.style.display='block'; statusEl.style.color='var(--bk-accent,#C86000)';
          statusEl.innerHTML='<div style="background:rgba(244,123,0,.1);border:1px solid rgba(244,123,0,.25);border-radius:10px;padding:12px 14px;margin:6px 0;font-size:.84rem;line-height:1.6">⚠️ Payment gateway could not load.<br><strong>Your booking is saved</strong> — tap <em>Confirm on WhatsApp</em> below.</div>';
          const waBtn=document.querySelector('.bkm-btn-wa'); if(waBtn){setTimeout(()=>waBtn.scrollIntoView({behavior:'smooth',block:'center'}),300); waBtn.style.animation='waPulse 1s ease-in-out 3';}
        }
      }
    },500);
    return;
  }
  let order;
  try{
    let res, rawText;
    try{
      res = await fetch('/api/payment/create-order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:amt,bookingId:BKM.S.bookingId})});
      rawText = await res.text();
      order = JSON.parse(rawText);
    }catch(fetchErr){
      // Network failure OR worker route not found (returned HTML instead of JSON)
      const isRouteError = rawText && rawText.trim().startsWith('<');
      throw new Error(isRouteError
        ? 'Worker route not responding — check Cloudflare route config'
        : ('Network/parse error: '+fetchErr.message));
    }
    if(!res.ok || !order.order_id){
      // Log the full server response for debugging
      console.error('[OWB Pay] Server error:', JSON.stringify(order));
      throw new Error(order.error || ('Server returned HTTP '+res.status));
    }
  }catch(e){
    console.error('[OWB Pay] create-order failed:', e.message);
    bkmToast('⚠️ Could not start payment. Please confirm via WhatsApp below.');
    if(statusEl){ statusEl.style.display='block'; statusEl.style.color='var(--bk-accent,#C86000)';
      const errMsg = e.message && e.message!=='order_failed'
        ? `<br><small style="opacity:.7;font-size:.8rem;display:block;margin-top:4px">Debug: ${e.message}</small>`
        : '';
      statusEl.innerHTML=`<div style="background:rgba(244,123,0,.1);border:1px solid rgba(244,123,0,.25);border-radius:10px;padding:12px 14px;margin:6px 0;font-size:.84rem;line-height:1.6">⚠️ Online payment is temporarily unavailable.<br><strong>Your booking is saved</strong> — please tap <em>Confirm on WhatsApp</em> below.${errMsg}</div>`; }
    const waBtn=document.querySelector('.bkm-btn-wa');
    if(waBtn){ setTimeout(()=>waBtn.scrollIntoView({behavior:'smooth',block:'center'}),300); waBtn.style.animation='waPulse 1s ease-in-out 3'; }
    return;
  }
  const options={
    key:order.key_id, order_id:order.order_id, amount:order.amount, currency:order.currency||'INR',
    name:'One-Way Bhaarat', description:`Cab Booking — ${BKM.S.vehicleName}`,
    prefill:{name:BKM.S.name,email:BKM.S.email,contact:'91'+BKM.S.phone},
    notes:{booking_id:BKM.S.bookingId}, theme:{color:'#F47B00'},
    handler(response){ _bkmVerifyAndConfirm(response,statusEl); }
  };
  new Razorpay(options).open();
}

async function _bkmVerifyAndConfirm(response,statusEl){
  try{
    const res=await fetch('/api/payment/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({razorpay_order_id:response.razorpay_order_id,razorpay_payment_id:response.razorpay_payment_id,razorpay_signature:response.razorpay_signature})});
    const data=await res.json();
    if(!data.verified){
      bkmToast('⚠️ Payment could not be verified. Please contact us if money was deducted.');
      if(statusEl){ statusEl.style.display='block'; statusEl.style.color='var(--sf-400)'; statusEl.textContent='⚠️ Payment verification failed.'; }
      return;
    }
    bkmToast('✅ Payment successful! Booking confirmed.');
    if(statusEl){ statusEl.style.display='block'; statusEl.style.color='var(--gr-300)'; statusEl.textContent='✅ Payment successful! Booking ID: '+BKM.S.bookingId; }
    // Lock the payment panel immediately so the booking can't be paid for
    // twice and the form doesn't look "still active" once it's done.
    _bkmLockPayPanel();
    // Send both admin + customer WhatsApp notifications. These are
    // best-effort (the worker already treats them as non-critical), so we
    // race them against a timeout — a slow/hanging WhatsApp API call must
    // never trap the customer on this screen after they've already paid.
    // Fire admin + customer notifications in parallel with independent
    // 8-second timeouts — sequential was fine in theory but if the admin
    // notify took the full 8s the customer message was silently skipped.
    const _withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(r, ms))]);
    await Promise.all([
      _withTimeout(_bkmNotifyPayment(response.razorpay_payment_id), 8000),
      _withTimeout(_bkmNotifyCustomer(response.razorpay_payment_id), 8000)
    ]);
    _bkmShowDoneScreen();
  }catch(e){
    bkmToast('⚠️ Could not confirm payment status. Please contact us if money was deducted.');
  }
}

// Disable the "Pay Now" button and payment-amount options the instant
// payment is verified — prevents double-payment and stops the panel from
// looking like it's still waiting for input.
function _bkmLockPayPanel(){
  document.querySelectorAll('.bkm-pay-opt').forEach(el=>{ el.disabled=true; el.style.opacity='.5'; el.style.pointerEvents='none'; });
  const payBtn=document.querySelector('.bkm-btn-pay');
  if(payBtn){ payBtn.disabled=true; payBtn.style.opacity='.5'; payBtn.style.pointerEvents='none'; payBtn.textContent='✓ PAID'; }
  const customRow=document.getElementById('bkmCustomRow');
  if(customRow) customRow.style.display='none';
  // "Confirm on WhatsApp" is a manual fallback for when payment fails —
  // once payment has actually succeeded and both WhatsApp notifications
  // are on their way, it no longer serves a purpose, so hide it.
  const waBtn=document.querySelector('.bkm-btn-wa');
  if(waBtn) waBtn.style.display='none';
}

// Replaces the confirmation panel with a final "all done" message once
// payment is verified and both notifications have been sent, then closes
// the modal automatically after a short pause so the person has time to
// read their booking ID.
function _bkmShowDoneScreen(){
  // Mark step 5 pill as "done" (green) — without this it stays orange/"active" forever
  const p5=document.getElementById('bkmp5');
  if(p5){ p5.classList.remove('active'); p5.classList.add('done'); }

  // Hide payment panel + status + WA button — _bkmShowDoneScreen only replaces the
  // title text, so these siblings stay visible unless we explicitly remove them.
  const payPanel=document.querySelector('.bkm-pay-panel');
  if(payPanel) payPanel.style.display='none';
  const payStatus=document.getElementById('bkmPayStatus');
  if(payStatus) payStatus.style.display='none';
  const waBtn=document.querySelector('.bkm-btn-wa');
  if(waBtn) waBtn.style.display='none';

  const wrap=document.querySelector('.bkm-confirm-wrap');
  if(wrap){
    const ic=wrap.querySelector('.bkm-confirm-ic');
    if(ic) ic.textContent='✓';
    const title=wrap.querySelector('h3');
    if(title) title.textContent='BOOKING CONFIRMED!';
    const sub=wrap.querySelector('p');
    if(sub) sub.textContent='Payment received. We\u2019ve sent confirmation on WhatsApp — our team will assign your driver shortly.';
  }
  bkmToast('✅ Booking confirmed — closing…', 3500);
  setTimeout(()=>{ bkmClose(); }, 3500);
}

function bkmSendWA(){
  const S=BKM.S;
  const stops=(S.extraCities||[]).filter(c=>c.trim());
  const msg=encodeURIComponent(
    `✅ *One-Way Bhaarat – Booking Confirmed!*\n\n`+
    `🔖 Booking ID: ${S.bookingId}\n`+
    `👤 ${S.name} · +91 ${S.phone}\n`+
    `📧 ${S.email}\n`+
    `🚗 ${S.vehicleName}\n`+
    `🎯 ${S.trip==='roundtrip'?'Round Trip':'One Way'}\n`+
    `📍 ${S.pu}${stops.length?' → '+stops.join(' → '):''} → ${S.dr}\n`+
    `📅 ${S.date} at ${S.time}${S.retdate?' · Return: '+S.retdate:''}\n`+
    `📏 ~${S.distKm} km\n`+
    `💰 Est. Fare: ₹${S.totalFare.toLocaleString('en-IN')}\n`+
    `${S.notes?'📝 Notes: '+S.notes+'\n':''}`+
    `\nPlease confirm driver assignment. Thank you! 🙏`
  );
  window.open(`https://wa.me/${ADMIN_WA}?text=${msg}`,'_blank');
}

async function _bkmNotifyAdmin(){
  const S=BKM.S;
  try{
    await fetch('/api/booking/notify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({verifyToken:S.verifyToken,booking:{id:S.bookingId,name:S.name,phone:S.phone,email:S.email,from:S.pu,to:S.dr,vehicle:S.vehicleName,tripType:S.trip,date:S.date,time:S.time,retdate:S.retdate,fare:S.totalFare,advance:S.advAmt,pax:S.pax,distKm:S.distKm,notes:S.notes,extraCities:S.extraCities||[]}})});
  }catch(e){ /* non-critical */ }
}

async function _bkmNotifyPayment(paymentId){
  // Must send the full booking object — worker.js builds tripDetails
  // (vehicle|from→to) and tripTiming (date time) from these fields.
  // The old payload omitted from/to/date/time/extraCities, which caused
  // the WhatsApp template parameters to arrive as "—", triggering Meta
  // error 132000 (parameter mismatch) and silently dropping the message.
  const S=BKM.S; const stops=(S.extraCities||[]).filter(c=>c.trim());
  try{
    await fetch('/api/booking/notify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({booking:{id:S.bookingId,paymentId,payAmt:S.payAmt,name:S.name,phone:S.phone,email:S.email,from:S.pu,to:S.dr,vehicle:S.vehicleName,tripType:S.trip,date:S.date,time:S.time,retdate:S.retdate,fare:S.totalFare,advance:S.advAmt,distKm:S.distKm,pax:S.pax,notes:S.notes,extraCities:stops,type:'payment'}})});
  }catch(e){ /* non-critical */ }
}

async function _bkmNotifyCustomer(paymentId){
  const S=BKM.S; const stops=(S.extraCities||[]).filter(c=>c.trim());
  try{
    await fetch('/api/booking/customer-confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({verifyToken:S.verifyToken,booking:{id:S.bookingId,name:S.name,phone:S.phone,from:S.pu,to:S.dr,vehicle:S.vehicleName,tripType:S.trip,date:S.date,time:S.time,retdate:S.retdate,fare:S.totalFare,advance:S.advAmt,payAmt:S.payAmt,distKm:S.distKm,pax:S.pax,notes:S.notes,extraCities:stops,paymentId:paymentId||''}})});
  }catch(e){ /* non-critical */ }
}

function bkmAddStop(){
  const idx=(BKM.S.extraCities||[]).length;
  if(!BKM.S.extraCities) BKM.S.extraCities=[];
  const list=document.getElementById('bkm-stop-list');
  if(!list) return;
  const row=document.createElement('div');
  row.id='bkm-srow-'+idx; row.className='bkm-stop-item';
  row.innerHTML=`<input type="text" id="bkm-sinp-${idx}" placeholder="Enter stop location…" autocomplete="off" style="flex:1;border:1.5px solid rgba(244,123,0,.3);border-radius:9px;padding:9px 12px;font-size:.82rem;background:rgba(255,255,255,.05);color:#fff;font-family:'Nunito',sans-serif;outline:none;box-sizing:border-box"/>
    <button type="button" onclick="bkmConfirmStop(${idx})" style="background:linear-gradient(135deg,var(--sf-500),var(--sf-700));border:none;border-radius:8px;padding:7px 12px;color:#fff;cursor:pointer;font-size:.78rem;font-weight:700;flex-shrink:0;white-space:nowrap;font-family:'Nunito',sans-serif">Add ✓</button>`;
  list.appendChild(row);
  const inp=document.getElementById('bkm-sinp-'+idx);
  if(inp){ inp.focus(); _bkmAttachAC(inp,name=>{ inp.value=name; }); }
}

function bkmConfirmStop(idx){
  const inp=document.getElementById('bkm-sinp-'+idx);
  const val=inp?inp.value.trim():'';
  if(!val){ bkmToast('⚠️ Please enter a stop location'); return; }
  if(!BKM.S.extraCities) BKM.S.extraCities=[];
  BKM.S.extraCities[idx]=val;
  _bkmRenderStops();
  BKM.S.distKm=0;
  const distEl=document.getElementById('bkm-dist'); if(distEl) distEl.classList.remove('show');
  _bkmMaybeLiveDist();
}

function _bkmRenderStops(){
  const list=document.getElementById('bkm-stop-list');
  if(!list) return;
  list.innerHTML=(BKM.S.extraCities||[]).filter(c=>c.trim()).map((c,i)=>`
    <div class="bkm-stop-item">
      <div class="bkm-stop-pill">📍 Stop ${i+1}: ${c}</div>
      <button type="button" class="bkm-stop-rm" onclick="bkmRemoveStop(${i})">✕</button>
    </div>`).join('');
}

function bkmRemoveStop(i){
  BKM.S.extraCities.splice(i,1); _bkmRenderStops();
  BKM.S.distKm=0;
  const distEl=document.getElementById('bkm-dist'); if(distEl) distEl.classList.remove('show');
  _bkmMaybeLiveDist();
}

const _bkmAcReqIds={};
let _bkmPortalActive=null;

function _bkmAttachAC(inp,cb){
  if(!inp) return;
  const id=inp.id||('ac-'+Math.random().toString(36).slice(2));
  inp.id=id;
  let timer;
  inp.addEventListener('input',()=>{ clearTimeout(timer); timer=setTimeout(()=>_bkmFetchAC(inp.value.trim(),id,cb,inp),280); });
  inp.addEventListener('blur',()=>{ const portal=document.getElementById('owb-ac-portal'); if(portal&&!portal._touching) setTimeout(()=>_bkmHidePortal(),120); });
  inp.addEventListener('focus',()=>{ if(inp.value.trim().length>=2) _bkmFetchAC(inp.value.trim(),id,cb,inp); });
}

async function _bkmFetchAC(q,id,cb,inp){
  if(q.length<2){ _bkmHidePortal(); return; }
  const myReq=(_bkmAcReqIds[id]=(_bkmAcReqIds[id]||0)+1);
  try{
    const res=await fetch(`/api/places?input=${encodeURIComponent(q)}`);
    const data=await res.json();
    if(_bkmAcReqIds[id]!==myReq) return;
    const preds=(data.predictions||[]).map(p=>({n:p.description,s:p.structured_formatting?.secondary_text||''}));
    _bkmShowPortal(preds,cb,inp);
  }catch(e){ _bkmHidePortal(); }
}

function _bkmShowPortal(preds,cb,inp){
  const portal=document.getElementById('owb-ac-portal');
  if(!portal) return;
  if(!preds.length){ _bkmHidePortal(); return; }
  portal._touching=false;
  portal.innerHTML=preds.map(p=>`<div class="bkm-ac-item"><div><div class="bkm-ac-main">📍 ${p.n}</div>${p.s?`<div class="bkm-ac-sub">${p.s}</div>`:''}</div></div>`).join('');
  portal.querySelectorAll('.bkm-ac-item').forEach((el,i)=>{
    el.addEventListener('mousedown',e=>{e.preventDefault();cb(preds[i].n);_bkmHidePortal();});
    el.addEventListener('touchstart',()=>{portal._touching=true;},{passive:true});
    el.addEventListener('touchend',()=>{cb(preds[i].n);_bkmHidePortal();setTimeout(()=>{portal._touching=false;},50);});
  });
  const rect=inp.getBoundingClientRect();
  portal.className='u-portal';
  portal.style.top=`${rect.bottom+4}px`;
  portal.style.left=`${rect.left}px`;
  portal.style.width=`${rect.width}px`;
  _bkmPortalActive=inp;
}

function _bkmHidePortal(){
  const portal=document.getElementById('owb-ac-portal');
  if(portal){portal.style.display='none';portal.innerHTML='';}
  _bkmPortalActive=null;
}

function _bkmMaybeLiveDist(){
  const pu=(BKM.S.pu||(document.getElementById('bk-pu')||{}).value||'').trim();
  const dr=(BKM.S.dr||(document.getElementById('bk-dr')||{}).value||'').trim();
  if(!pu||!dr) return;
  const isRound=BKM.S.trip==='roundtrip';
  const stops=(BKM.S.extraCities||[]).filter(c=>c.trim());
  // Round trip: close the loop — end back at pickup
  const waypoints=isRound?[pu,...stops,dr,pu]:[pu,...stops,dr];
  _bkmShowDist('Calculating…');
  if(waypoints.length>2){ _bkmFetchDistMultiStop(waypoints); }
  else { _bkmFetchDist(pu,dr); }
}

function _bkmFmtDate(s){
  if(!s) return '—';
  const d=new Date(s+'T00:00:00');
  return d.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'});
}
function _bkmFmtTime(s){
  if(!s) return '—';
  const [h,m]=s.split(':');
  const hr=parseInt(h); const ampm=hr>=12?'PM':'AM';
  return `${((hr%12)||12)}:${m} ${ampm}`;
}

// ══════════════════════════════════════════════════════════════
//  DOM-DEPENDENT INIT — runs after DOM is ready
// ══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {

  // Date/time defaults (hero widget)
  const pdateEl = document.getElementById('pdate');
  const ptimeEl = document.getElementById('ptime');
  const todayStr = new Date().toISOString().split('T')[0];
  if(pdateEl){ pdateEl.min = todayStr; pdateEl.value = todayStr; }
  if(ptimeEl){
    const defaultTime = new Date(Date.now() + 75 * 60 * 1000);
    const defHH = String(defaultTime.getHours()).padStart(2, '0');
    const defMM = String(defaultTime.getMinutes()).padStart(2, '0');
    ptimeEl.value = `${defHH}:${defMM}`;
  }

  // Route cards
  const grid = document.getElementById('routesGrid');
  if(grid){
    ROUTES.forEach(r => {
      const el = document.createElement('div');
      el.className = 'route-card'; el.style.cursor = 'pointer';
      el.onclick = () => { BKM.S.pu=r.from; BKM.S.dr=r.to; BKM._preDistKm=r.d; bkmOpen({prefill:true}); };
      el.innerHTML = `
        <div class="route-emoji">${r.icon}</div>
        <div class="route-info">
          <div class="route-name">${r.from} → ${r.to}</div>
          <div class="route-meta">${r.d} km · Sedan One Way</div>
        </div>
        <div class="route-price-col">
          <div class="route-price">₹${r.p.toLocaleString('en-IN')}</div>
          <div class="route-dist">${r.d} km</div>
        </div>`;
      grid.appendChild(el);
    });
  }

  // Scroll reveal
  document.querySelectorAll('.reveal').forEach(el => ro.observe(el));

  // Autocomplete
  if(window.google && google.maps && google.maps.places) initAutocomplete();
  else if(!IS_LOCAL) initAutocomplete();

  // Booking modal: only close via X button, not overlay click
  const bkModal = document.getElementById('bkModal');

  // Modal pickup mirrors to locked drop in round-trip mode
  const bkPu = document.getElementById('bk-pu');
  if(bkPu) bkPu.addEventListener('input', function(){
    if(BKM.S.trip==='roundtrip'){
      const drEl=document.getElementById('bk-dr');
      if(drEl){ drEl.value=this.value; BKM.S.dr=this.value; }
    }
  });

  // Modal date defaults
  const todayDate = new Date().toISOString().split('T')[0];
  ['bk-dt','bk-ret'].forEach(id => { const el=document.getElementById(id); if(el) el.min=todayDate; });
  const bkDt=document.getElementById('bk-dt'); if(bkDt&&!bkDt.value) bkDt.value=todayDate;
  const t=new Date(Date.now()+2*60*60*1000);
  const hh=String(t.getHours()).padStart(2,'0'); const mm=String(t.getMinutes()).padStart(2,'0');
  const bkTm=document.getElementById('bk-tm'); if(bkTm&&!bkTm.value) bkTm.value=`${hh}:${mm}`;

  // Modal AC
  const bkPuEl=document.getElementById('bk-pu');
  const bkDrEl=document.getElementById('bk-dr');
  if(bkPuEl) _bkmAttachAC(bkPuEl, name=>{
    bkPuEl.value=name; BKM.S.pu=name;
    if(BKM.S.trip==='roundtrip'&&bkDrEl){ bkDrEl.value=name; BKM.S.dr=name; }
    BKM.S.distKm=0; BKM._preDistKm=0;
    const distEl=document.getElementById('bkm-dist'); if(distEl) distEl.classList.remove('show');
    const lf=document.getElementById('bkmLiveFares'); if(lf) lf.classList.remove('show');
    _bkmMaybeLiveDist();
  });
  if(bkDrEl) _bkmAttachAC(bkDrEl, name=>{
    bkDrEl.value=name; BKM.S.dr=name;
    BKM.S.distKm=0; BKM._preDistKm=0;
    const distEl=document.getElementById('bkm-dist'); if(distEl) distEl.classList.remove('show');
    const lf=document.getElementById('bkmLiveFares'); if(lf) lf.classList.remove('show');
    _bkmMaybeLiveDist();
  });

  // Portal close on outside click + Escape
  document.addEventListener('click', e=>{
    const portal=document.getElementById('owb-ac-portal');
    if(portal&&_bkmPortalActive&&!_bkmPortalActive.contains(e.target)&&!portal.contains(e.target)) _bkmHidePortal();
  });
  document.addEventListener('keydown', e=>{ if(e.key==='Escape') bkmClose(); });

  // Run calc fare if elements exist
  calcFare();
});
