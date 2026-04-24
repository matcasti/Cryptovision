
// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════
const STATE = {
  coins: [],
  historyCache: {},
  selectedChartCoin: 'bitcoin',
  selectedPredCoin: 'bitcoin',
  chartTf: 30,
  overlays: { sma:true, ema:true, bb:true, vol:true },
  subs: { rsi:true, macd:true },
  portfolio: JSON.parse(localStorage.getItem('cv_portfolio') || '[]'),
  watchlist: JSON.parse(localStorage.getItem('cv_watchlist') || '["bitcoin","ethereum","binancecoin"]'),
  alerts: JSON.parse(localStorage.getItem('cv_alerts') || '[]'),
  watchNotes: JSON.parse(localStorage.getItem('cv_watch_notes') || '{}'),
  fng: null,
  globalData: null,
  signalLog: [],
  charts: {},
  sortKey: 'marketCap',
  sortDir: -1,
  lastPrices: {}
};

// ═══════════════════════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════════════════════
const BASE = 'https://api.coingecko.com/api/v3';
const FNG_URL = 'https://api.alternative.me/fng/?limit=5';

async function fetchMarkets() {
  const ids = STATE.watchlist.concat(['bitcoin','ethereum','binancecoin','solana','ripple','cardano','avalanche-2','polkadot','chainlink','uniswap']).filter((v,i,a)=>a.indexOf(v)===i).slice(0,25).join(',');
  const url = `${BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=true&price_change_percentage=1h%2C24h%2C7d`;
  const r = await fetch(url);
  return r.json();
}

async function fetchHistory(id, days) {
  const key = `${id}_${days}`;
  if (STATE.historyCache[key] && STATE.historyCache[key].ts > Date.now() - 60000) return STATE.historyCache[key].data;
  const r = await fetch(`${BASE}/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=${days<=7?'hourly':'daily'}`);
  const d = await r.json();
  STATE.historyCache[key] = { ts: Date.now(), data: d };
  return d;
}

async function fetchFNG() {
  const r = await fetch(FNG_URL);
  return r.json();
}

async function fetchGlobal() {
  const r = await fetch(`${BASE}/global`);
  return r.json();
}

// ═══════════════════════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS
// ═══════════════════════════════════════════════════════════════════════════════
function sma(data, p) {
  return data.map((_, i) => {
    if (i < p - 1) return null;
    return data.slice(i-p+1, i+1).reduce((a,b)=>a+b,0)/p;
  });
}
function ema(data, p) {
  const k = 2/(p+1); let r = [data[0]];
  for (let i=1; i<data.length; i++) r.push(data[i]*k + r[i-1]*(1-k));
  return r;
}
function rsiCalc(data, p=14) {
  const ch = data.slice(1).map((v,i)=>v-data[i]);
  const gains = ch.map(c=>Math.max(c,0)), losses = ch.map(c=>Math.max(-c,0));
  const r = [];
  let ag = gains.slice(0,p).reduce((a,b)=>a+b,0)/p;
  let al = losses.slice(0,p).reduce((a,b)=>a+b,0)/p;
  r.push(100-100/(1+ag/(al||0.001)));
  for (let i=p; i<ch.length; i++) {
    ag=(ag*(p-1)+gains[i])/p; al=(al*(p-1)+losses[i])/p;
    r.push(100-100/(1+ag/(al||0.001)));
  }
  return Array(p).fill(null).concat(r);
}
function macdCalc(data, fast=12, slow=26, sig=9) {
  const ef=ema(data,fast), es=ema(data,slow);
  const ml=ef.map((v,i)=>v-es[i]);
  const sl=ema(ml.slice(slow-1),sig);
  const pad=slow-1;
  const hist=ml.slice(pad).map((v,i)=>v-(sl[i]||0));
  return { macdLine:ml, signalLine:Array(pad).fill(null).concat(sl), histogram:Array(pad).fill(null).concat(hist) };
}
function bollingerBands(data, p=20, sd=2) {
  const m=sma(data,p), u=[], l=[];
  for (let i=0; i<data.length; i++) {
    if (i<p-1){u.push(null);l.push(null);continue;}
    const s=data.slice(i-p+1,i+1), mean=m[i];
    const variance=s.reduce((a,b)=>a+Math.pow(b-mean,2),0)/p;
    const std=Math.sqrt(variance);
    u.push(mean+sd*std); l.push(mean-sd*std);
  }
  return {upper:u,middle:m,lower:l};
}
function linReg(y) {
  const n=y.length, x=Array.from({length:n},(_,i)=>i);
  const sx=x.reduce((a,b)=>a+b,0), sy=y.reduce((a,b)=>a+b,0);
  const sxy=x.reduce((a,b,i)=>a+b*y[i],0), sxx=x.reduce((a,b)=>a+b*b,0);
  const slope=(n*sxy-sx*sy)/(n*sxx-sx*sx);
  const intercept=(sy-slope*sx)/n;
  return {slope, intercept, predict:x=>slope*x+intercept};
}
function stdev(arr) {
  const m=arr.reduce((a,b)=>a+b,0)/arr.length;
  return Math.sqrt(arr.reduce((a,b)=>a+Math.pow(b-m,2),0)/arr.length);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PREDICTION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
function analyzeSignals(prices, volumes) {
  if (!prices || prices.length < 30) return null;
  const p = prices;
  const n = p.length;
  const current = p[n-1];

  // Indicators
  const sma20 = sma(p,20), sma50 = sma(p,Math.min(50,n));
  const ema12 = ema(p,12), ema26 = ema(p,26);
  const rsi = rsiCalc(p,14);
  const macd = macdCalc(p);
  const bb = bollingerBands(p,20);
  const lr = linReg(p.slice(-30));

  // Current values
  const rsiNow = rsi.filter(v=>v!==null).slice(-1)[0];
  const macdNow = macd.macdLine[n-1];
  const macdSignalLine = macd.signalLine[n-1];
  const macdHist = macd.histogram[n-1];
  const bbUpper = bb.upper[n-1];
  const bbLower = bb.lower[n-1];
  const bbMid = bb.middle[n-1];
  const sma20Now = sma20[n-1];
  const sma50Now = sma50[n-1];
  const ema12Now = ema12[n-1];
  const ema26Now = ema26[n-1];

  // BB %B
  const bbPctB = bbUpper && bbLower ? (current-bbLower)/(bbUpper-bbLower) : 0.5;

  // Volume trend
  let volSignal = 0;
  if (volumes && volumes.length >= 5) {
    const recentVol = volumes.slice(-3).reduce((a,b)=>a+b,0)/3;
    const avgVol = volumes.slice(-14).reduce((a,b)=>a+b,0)/14;
    volSignal = recentVol > avgVol * 1.5 ? 1 : recentVol < avgVol * 0.7 ? -1 : 0;
  }

  // Score each indicator (-2 to +2)
  const indicators = [];

  // RSI
  let rsiScore=0, rsiSig='Neutral', rsiDesc='';
  if (rsiNow < 25) { rsiScore=2; rsiSig='Strong Buy'; rsiDesc='Heavily oversold — potential reversal'; }
  else if (rsiNow < 40) { rsiScore=1; rsiSig='Buy'; rsiDesc='Below neutral — bullish bias'; }
  else if (rsiNow > 75) { rsiScore=-2; rsiSig='Strong Sell'; rsiDesc='Heavily overbought — potential reversal'; }
  else if (rsiNow > 60) { rsiScore=-1; rsiSig='Sell'; rsiDesc='Above neutral — bearish bias'; }
  else { rsiSig='Neutral'; rsiDesc='No strong signal'; }
  indicators.push({ name:'RSI (14)', value:rsiNow?.toFixed(1), score:rsiScore, signal:rsiSig, desc:rsiDesc, bar:rsiNow/100 });

  // MACD
  let macdScore=0, macdSig='Neutral', macdDesc='';
  if (macdHist > 0 && macdNow > macdSignalLine) { macdScore=2; macdSig='Strong Buy'; macdDesc='MACD above signal, positive histogram'; }
  else if (macdHist > 0) { macdScore=1; macdSig='Buy'; macdDesc='Positive momentum building'; }
  else if (macdHist < 0 && macdNow < macdSignalLine) { macdScore=-2; macdSig='Strong Sell'; macdDesc='MACD below signal, negative histogram'; }
  else if (macdHist < 0) { macdScore=-1; macdSig='Sell'; macdDesc='Negative momentum building'; }
  else { macdSig='Neutral'; macdDesc='MACD converging'; }
  indicators.push({ name:'MACD', value:`${macdHist?.toFixed(2)}`, score:macdScore, signal:macdSig, desc:macdDesc, bar:0.5+macdScore/4 });

  // Bollinger Bands
  let bbScore=0, bbSig='Neutral', bbDesc='';
  if (bbPctB < 0.1) { bbScore=2; bbSig='Strong Buy'; bbDesc='Price at/below lower band'; }
  else if (bbPctB < 0.3) { bbScore=1; bbSig='Buy'; bbDesc='Price in lower zone'; }
  else if (bbPctB > 0.9) { bbScore=-2; bbSig='Strong Sell'; bbDesc='Price at/above upper band'; }
  else if (bbPctB > 0.7) { bbScore=-1; bbSig='Sell'; bbDesc='Price in upper zone'; }
  else { bbSig='Neutral'; bbDesc='Price within normal range'; }
  indicators.push({ name:'Bollinger %B', value:`${(bbPctB*100).toFixed(1)}%`, score:bbScore, signal:bbSig, desc:bbDesc, bar:bbPctB });

  // SMA Cross
  let smaScore=0, smaSig='Neutral', smaDesc='';
  if (sma20Now && sma50Now) {
    if (current > sma20Now && sma20Now > sma50Now) { smaScore=2; smaSig='Strong Buy'; smaDesc='Price > SMA20 > SMA50 (golden zone)'; }
    else if (current > sma20Now) { smaScore=1; smaSig='Buy'; smaDesc='Price above short-term average'; }
    else if (current < sma20Now && sma20Now < sma50Now) { smaScore=-2; smaSig='Strong Sell'; smaDesc='Price < SMA20 < SMA50 (death zone)'; }
    else { smaScore=-1; smaSig='Sell'; smaDesc='Price below short-term average'; }
  }
  indicators.push({ name:'SMA Cross', value:`${((current/sma20Now-1)*100)?.toFixed(1)}%`, score:smaScore, signal:smaSig, desc:smaDesc, bar:0.5+smaScore/4 });

  // EMA Cross
  let emaScore=0, emaSig='Neutral', emaDesc='';
  if (ema12Now > ema26Now) {
    const margin = (ema12Now-ema26Now)/ema26Now;
    emaScore = margin > 0.02 ? 2 : 1; emaSig = emaScore===2?'Strong Buy':'Buy';
    emaDesc = 'EMA12 above EMA26 — bullish';
  } else {
    const margin = (ema26Now-ema12Now)/ema26Now;
    emaScore = margin > 0.02 ? -2 : -1; emaSig = emaScore===-2?'Strong Sell':'Sell';
    emaDesc = 'EMA12 below EMA26 — bearish';
  }
  indicators.push({ name:'EMA Cross', value:`${ema12Now?.toFixed(0)}`, score:emaScore, signal:emaSig, desc:emaDesc, bar:0.5+emaScore/4 });

  // Trend (linear regression)
  const slopePct = (lr.slope/current)*100;
  let trendScore=0, trendSig='Neutral', trendDesc='';
  if (slopePct > 1) { trendScore=2; trendSig='Strong Buy'; trendDesc=`Strong uptrend: +${slopePct.toFixed(2)}%/period`; }
  else if (slopePct > 0.2) { trendScore=1; trendSig='Buy'; trendDesc=`Mild uptrend: +${slopePct.toFixed(2)}%/period`; }
  else if (slopePct < -1) { trendScore=-2; trendSig='Strong Sell'; trendDesc=`Strong downtrend: ${slopePct.toFixed(2)}%/period`; }
  else if (slopePct < -0.2) { trendScore=-1; trendSig='Sell'; trendDesc=`Mild downtrend: ${slopePct.toFixed(2)}%/period`; }
  else { trendDesc='Sideways trend'; }
  indicators.push({ name:'Trend (LinReg)', value:`${slopePct.toFixed(2)}%`, score:trendScore, signal:trendSig, desc:trendDesc, bar:0.5+trendScore/4 });

  // Volume
  indicators.push({ name:'Volume Trend', value:volSignal>0?'High':volSignal<0?'Low':'Normal', score:volSignal, signal:volSignal>0?'Bullish':volSignal<0?'Bearish':'Neutral', desc:'Relative to 14-day average', bar:0.5+volSignal/4 });

  // Composite score
  const totalScore = indicators.reduce((a,b)=>a+b.score,0);
  const maxScore = indicators.length * 2;
  const normalizedScore = ((totalScore + maxScore) / (2*maxScore)) * 10;

  let signal, signalClass;
  if (totalScore >= 6) { signal='STRONG BUY'; signalClass='strong-buy'; }
  else if (totalScore >= 2) { signal='BUY'; signalClass='buy'; }
  else if (totalScore <= -6) { signal='STRONG SELL'; signalClass='strong-sell'; }
  else if (totalScore <= -2) { signal='SELL'; signalClass='sell'; }
  else { signal='HOLD'; signalClass='neutral'; }

  // Price targets
  const sd = stdev(p.slice(-30));
  const lrTarget = lr.predict(n + 7);
  const bearTarget = lrTarget - sd * 1.5;
  const bullTarget = lrTarget + sd * 1.5;

  return { indicators, totalScore, normalizedScore, signal, signalClass, lrTarget, bearTarget, bullTarget, lr, rsi, macd, bb, sma20, sma50, ema12, ema26 };
}

function signalColor(sig) {
  if (sig==='STRONG BUY'||sig==='Strong Buy') return 'var(--green)';
  if (sig==='BUY'||sig==='Buy') return 'var(--green2)';
  if (sig==='STRONG SELL'||sig==='Strong Sell') return 'var(--red)';
  if (sig==='SELL'||sig==='Sell') return 'var(--red2)';
  return 'var(--text3)';
}
function signalPill(sig) {
  const cls = sig.toLowerCase().replace(' ','-').replace('strong-buy','strong-buy').replace('strong-sell','strong-sell');
  const map = {'strong buy':'strong-buy','buy':'buy','hold':'neutral','neutral':'neutral','sell':'sell','strong sell':'strong-sell'};
  const c = map[sig.toLowerCase()] || 'neutral';
  return `<span class="signal-pill ${c}">${sig}</span>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORMATTING
// ═══════════════════════════════════════════════════════════════════════════════
function fmtPrice(v) {
  if (!v && v!==0) return '—';
  if (v >= 1000) return '$'+v.toLocaleString('en-US',{maximumFractionDigits:0});
  if (v >= 1) return '$'+v.toFixed(2);
  if (v >= 0.01) return '$'+v.toFixed(4);
  return '$'+v.toFixed(6);
}
function fmtPct(v) {
  if (!v && v!==0) return '—';
  return (v>=0?'+':'')+v.toFixed(2)+'%';
}
function fmtCap(v) {
  if (!v) return '—';
  if (v>=1e12) return '$'+(v/1e12).toFixed(2)+'T';
  if (v>=1e9) return '$'+(v/1e9).toFixed(2)+'B';
  if (v>=1e6) return '$'+(v/1e6).toFixed(2)+'M';
  return '$'+v.toFixed(0);
}
function pctClass(v) { return v>=0?'up':'down'; }

// ═══════════════════════════════════════════════════════════════════════════════
// CHART HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
const CH = {};
function makeOrUpdate(id, config) {
  if (CH[id]) { CH[id].destroy(); }
  const canvas = document.getElementById(id);
  if (!canvas) return null;
  const chart = new Chart(canvas, config);
  CH[id] = chart;
  return chart;
}

Chart.defaults.color = '#4a6070';
Chart.defaults.borderColor = '#1a2a3d';
Chart.defaults.font.family = "'IBM Plex Mono', monospace";
Chart.defaults.font.size = 10;

function sparklineConfig(data, up) {
  const color = up ? '#00e676' : '#ff3d5a';
  return {
    type:'line',
    data:{ datasets:[{ data, borderColor:color, borderWidth:1.5, pointRadius:0, tension:0.3 }] },
    options:{ responsive:false, animation:false, plugins:{legend:{display:false},tooltip:{enabled:false}}, scales:{x:{display:false},y:{display:false}} }
  };
}

function drawSparkline(canvas, data, up) {
  if (!canvas || !data || !data.length) return;
  const ctx = canvas.getContext('2d');
  const w=canvas.width, h=canvas.height;
  ctx.clearRect(0,0,w,h);
  const min=Math.min(...data), max=Math.max(...data), range=max-min||1;
  const pts = data.map((v,i)=>({ x:i*(w/(data.length-1)), y:h-(v-min)/range*h*0.85-h*0.075 }));
  const grad = ctx.createLinearGradient(0,0,0,h);
  const color = up ? '#00e676' : '#ff3d5a';
  grad.addColorStop(0, up?'rgba(0,230,118,0.15)':'rgba(255,61,90,0.15)');
  grad.addColorStop(1,'rgba(0,0,0,0)');
  ctx.beginPath();
  pts.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y));
  ctx.strokeStyle=color; ctx.lineWidth=1.5; ctx.stroke();
  ctx.lineTo(w,h); ctx.lineTo(0,h); ctx.closePath();
  ctx.fillStyle=grad; ctx.fill();
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEAR & GREED
// ═══════════════════════════════════════════════════════════════════════════════
function drawFngGauge(value) {
  const canvas = document.getElementById('fng-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w=200, h=110, cx=100, cy=100, r=80;
  ctx.clearRect(0,0,w,h);
  const colors = ['#ff3d5a','#ff7043','#ffab00','#a3d977','#00e676'];
  const zones = [0,20,40,60,80,100];
  for (let i=0; i<5; i++) {
    const sa=Math.PI+(zones[i]/100)*Math.PI;
    const ea=Math.PI+(zones[i+1]/100)*Math.PI;
    ctx.beginPath(); ctx.arc(cx,cy,r,sa,ea);
    ctx.strokeStyle=colors[i]; ctx.lineWidth=14; ctx.lineCap='round';
    ctx.globalAlpha=0.3; ctx.stroke();
  }
  ctx.globalAlpha=1;
  // Active arc
  const colorIdx = Math.min(4,Math.floor(value/20));
  const grad=ctx.createLinearGradient(cx-r,cy-r,cx+r,cy+r);
  grad.addColorStop(0,colors[colorIdx]);
  grad.addColorStop(1,colors[Math.min(4,colorIdx+1)]);
  ctx.beginPath(); ctx.arc(cx,cy,r,Math.PI,Math.PI+(value/100)*Math.PI);
  ctx.strokeStyle=grad; ctx.lineWidth=14; ctx.stroke();
  // Needle
  const angle=Math.PI+(value/100)*Math.PI;
  ctx.beginPath();
  ctx.moveTo(cx,cy);
  ctx.lineTo(cx+Math.cos(angle)*65,cy+Math.sin(angle)*65);
  ctx.strokeStyle='#e0eaf5'; ctx.lineWidth=2; ctx.lineCap='round'; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx,cy,5,0,Math.PI*2);
  ctx.fillStyle='#e0eaf5'; ctx.fill();
}

function fngColor(v) {
  if (v<20)return'#ff3d5a'; if(v<40)return'#ff7043'; if(v<60)return'#ffab00'; if(v<80)return'#a3d977'; return'#00e676';
}
function fngLabel(v) {
  if(v<20)return'Extreme Fear'; if(v<40)return'Fear'; if(v<60)return'Neutral'; if(v<80)return'Greed'; return'Extreme Greed';
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA LOADING & RENDERING
// ═══════════════════════════════════════════════════════════════════════════════
async function loadFNG() {
  try {
    const d = await fetchFNG();
    STATE.fng = d.data;
    const cur = parseInt(d.data[0].value);
    document.getElementById('fng-number').textContent = cur;
    document.getElementById('fng-number').style.color = fngColor(cur);
    document.getElementById('fng-label').textContent = fngLabel(cur);
    document.getElementById('fng-label').style.color = fngColor(cur);
    document.getElementById('ms-fng').textContent = cur;
    document.getElementById('ms-fng').className = 'mkt-stat-val';
    document.getElementById('ms-fng').style.color = fngColor(cur);
    document.getElementById('ms-fng-lbl').textContent = fngLabel(cur);
    drawFngGauge(cur);
    // History
    const hist = document.getElementById('fng-history');
    const labels = ['Today','Yesterday','3d ago','4d ago','5d ago'];
    hist.innerHTML = d.data.slice(0,5).map((item,i)=>{
      const v=parseInt(item.value);
      return `<div class="fng-row">
        <span class="fng-row-label">${labels[i]}</span>
        <span class="fng-row-val" style="color:${fngColor(v)}">${v} — ${fngLabel(v)}</span>
      </div>
      <div class="fng-bar-wrap"><div class="fng-bar" style="width:${v}%;background:${fngColor(v)}"></div></div>`;
    }).join('');
  } catch(e) { console.warn('FNG failed', e); }
}

async function loadGlobal() {
  try {
    const d = await fetchGlobal();
    const g = d.data;
    STATE.globalData = g;
    document.getElementById('h-mktcap').textContent = fmtCap(g.total_market_cap?.usd);
    document.getElementById('h-btcdom').textContent = g.market_cap_percentage?.btc?.toFixed(1)+'%';
    document.getElementById('h-vol').textContent = fmtCap(g.total_volume?.usd);
    document.getElementById('h-active').textContent = (g.active_cryptocurrencies||0).toLocaleString();
    drawDominanceChart(g.market_cap_percentage);
  } catch(e) { console.warn('Global failed', e); }
}

function drawDominanceChart(pcts) {
  const coins = Object.entries(pcts||{}).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const other = 100 - coins.reduce((a,[,v])=>a+v,0);
  const labels = [...coins.map(([k])=>k.toUpperCase()),'OTHER'];
  const data = [...coins.map(([,v])=>v), other];
  const colors = ['#00d4ff','#c3a634','#b060ff','#00e676','#ff3d5a','#ff7043','#4a6070'];
  makeOrUpdate('dominance-chart',{
    type:'doughnut',
    data:{ labels, datasets:[{ data, backgroundColor:colors.map(c=>c+'99'), borderColor:colors, borderWidth:1 }] },
    options:{ responsive:true, cutout:'65%', plugins:{ legend:{ display:true, position:'right', labels:{ font:{size:9,family:'IBM Plex Mono'}, color:'#8aabb0', boxWidth:10, padding:8 } }, tooltip:{ callbacks:{ label:ctx=>`${ctx.label}: ${ctx.raw.toFixed(1)}%` } } } }
  });
}

async function loadMarkets() {
  try {
    const data = await fetchMarkets();
    STATE.coins = data;
    renderCoinsTable();
    renderTicker();
    renderGainersLosers();
    buildCoinSelects();
    renderChartCoinList();
    renderWatchlist();
    updatePortfolio();
    renderMultiSignals();
    const now = new Date().toLocaleTimeString();
    document.getElementById('last-update').textContent = 'Updated '+now;
    document.getElementById('ms-refresh').textContent = now;
    const gainers = data.filter(c=>c.price_change_percentage_24h>0).length;
    const losers = data.filter(c=>c.price_change_percentage_24h<0).length;
    document.getElementById('ms-gainers').textContent = gainers;
    document.getElementById('ms-losers').textContent = losers;
    checkAlerts();
  } catch(e) { console.warn('Markets failed', e); showToast('Market data unavailable. Rate limit?'); }
}

function renderTicker() {
  const items = STATE.coins.slice(0,20).map(c=>{
    const chg = c.price_change_percentage_24h||0;
    return `<div class="ticker-item">
      <span class="sym">${c.symbol.toUpperCase()}</span>
      <span class="price">${fmtPrice(c.current_price)}</span>
      <span class="chg ${chg>=0?'up':'down'}">${fmtPct(chg)}</span>
    </div>`;
  }).join('');
  const inner = document.getElementById('ticker-inner');
  inner.innerHTML = items + items; // duplicate for seamless loop
}

let sortKey='marketCap', sortDir=-1;
function sortTable(key) {
  if (sortKey===key) sortDir*=-1; else { sortKey=key; sortDir=-1; }
  renderCoinsTable();
}

function renderCoinsTable() {
  const search = document.getElementById('coin-search')?.value?.toLowerCase()||'';
  let coins = [...STATE.coins].filter(c=>
    !search || c.name.toLowerCase().includes(search) || c.symbol.toLowerCase().includes(search)
  );
  const keyMap = { price:'current_price', change1h:'price_change_percentage_1h_in_currency', change24h:'price_change_percentage_24h', change7d:'price_change_percentage_7d_in_currency', marketCap:'market_cap' };
  const k = keyMap[sortKey];
  if (k) coins.sort((a,b)=>((a[k]||0)-(b[k]||0))*sortDir);

  let buys=0;
  const rows = coins.map((c,i)=>{
    const chg1h=c.price_change_percentage_1h_in_currency||0;
    const chg24=c.price_change_percentage_24h||0;
    const chg7d=c.price_change_percentage_7d_in_currency||0;
    const spark=c.sparkline_in_7d?.price||[];
    const sig=quickSignal(c);
    if(sig==='STRONG BUY'||sig==='BUY') buys++;
    return `<tr onclick="openChartCoin('${c.id}')">
      <td style="color:var(--text3)">${c.market_cap_rank||i+1}</td>
      <td><div class="coin-name-cell">
        <div class="coin-icon"><img src="${c.image}" onerror="this.style.display='none'"></div>
        <div><div class="coin-sym">${c.symbol.toUpperCase()}</div><div class="coin-name">${c.name}</div></div>
      </div></td>
      <td class="price-cell">${fmtPrice(c.current_price)}</td>
      <td class="chg-cell ${pctClass(chg1h)}">${fmtPct(chg1h)}</td>
      <td class="chg-cell ${pctClass(chg24)}">${fmtPct(chg24)}</td>
      <td class="chg-cell ${pctClass(chg7d)}">${fmtPct(chg7d)}</td>
      <td class="sparkline-cell"><canvas width="80" height="32" id="sp-${c.id}"></canvas></td>
      <td class="mc-cell">${fmtCap(c.market_cap)}</td>
      <td class="vol-cell">${fmtCap(c.total_volume)}</td>
      <td>${signalPill(sig)}</td>
    </tr>`;
  }).join('');
  document.getElementById('coins-tbody').innerHTML = rows;
  document.getElementById('ms-buys').textContent = buys;
  // Draw sparklines
  coins.forEach(c=>{
    const spark=c.sparkline_in_7d?.price||[];
    const chg7d=c.price_change_percentage_7d_in_currency||0;
    const canvas=document.getElementById('sp-'+c.id);
    if(canvas && spark.length) drawSparkline(canvas, spark, chg7d>=0);
  });
}

function quickSignal(c) {
  const chg1h=c.price_change_percentage_1h_in_currency||0;
  const chg24=c.price_change_percentage_24h||0;
  const chg7d=c.price_change_percentage_7d_in_currency||0;
  const spark=c.sparkline_in_7d?.price||[];
  if (!spark.length) return 'NEUTRAL';
  // Simple heuristic: use sparkline trend + changes
  const last5=spark.slice(-5);
  const trend5=(last5[4]-last5[0])/last5[0]*100;
  let score=0;
  if(chg1h>1) score+=1; else if(chg1h<-1) score-=1;
  if(chg24>3) score+=2; else if(chg24>1) score+=1; else if(chg24<-3) score-=2; else if(chg24<-1) score-=1;
  if(chg7d>10) score+=2; else if(chg7d>5) score+=1; else if(chg7d<-10) score-=2; else if(chg7d<-5) score-=1;
  if(trend5>2) score+=1; else if(trend5<-2) score-=1;
  if(score>=4) return 'STRONG BUY';
  if(score>=2) return 'BUY';
  if(score<=-4) return 'STRONG SELL';
  if(score<=-2) return 'SELL';
  return 'NEUTRAL';
}

function renderGainersLosers() {
  const sorted24 = [...STATE.coins].sort((a,b)=>(b.price_change_percentage_24h||0)-(a.price_change_percentage_24h||0));
  const gainers = sorted24.slice(0,5);
  const losers = sorted24.slice(-5).reverse();
  const mkRow=(c,up)=>`<div class="coin-list-item" style="padding:8px 14px">
    <div class="coin-icon"><img src="${c.image}" onerror="this.style.display='none'" style="width:100%;height:100%"></div>
    <div style="flex:1"><div style="font-family:var(--mono);font-size:11px;font-weight:700;color:${up?'var(--green)':'var(--red)'}">${c.symbol.toUpperCase()}</div>
    <div style="font-family:var(--mono);font-size:10px;color:var(--text3)">${fmtPrice(c.current_price)}</div></div>
    <div style="font-family:var(--mono);font-size:13px;font-weight:700;color:${up?'var(--green)':'var(--red)'}">${fmtPct(c.price_change_percentage_24h)}</div>
  </div>`;
  document.getElementById('top-gainers-list').innerHTML = gainers.map(c=>mkRow(c,true)).join('');
  document.getElementById('top-losers-list').innerHTML = losers.map(c=>mkRow(c,false)).join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHARTS TAB
// ═══════════════════════════════════════════════════════════════════════════════
function renderChartCoinList() {
  const html = STATE.coins.map(c=>{
    const chg=c.price_change_percentage_24h||0;
    return `<div class="coin-list-item ${c.id===STATE.selectedChartCoin?'active':''}" onclick="openChartCoin('${c.id}')">
      <div class="coin-icon"><img src="${c.image}" onerror="this.style.display='none'" style="width:100%;height:100%"></div>
      <div class="cli-info">
        <div class="cli-sym">${c.symbol.toUpperCase()}</div>
        <div class="cli-price">${fmtPrice(c.current_price)}</div>
        <div class="cli-chg ${pctClass(chg)}">${fmtPct(chg)}</div>
      </div>
    </div>`;
  }).join('');
  const el = document.getElementById('chart-coin-list');
  if(el) el.innerHTML = html;
}

async function openChartCoin(id) {
  STATE.selectedChartCoin = id;
  switchTab('charts');
  renderChartCoinList();
  await loadChartData(id);
}

async function loadChartData(id) {
  const coin = STATE.coins.find(c=>c.id===id);
  if(coin) {
    document.getElementById('price-chart-title').textContent = `${coin.name} (${coin.symbol.toUpperCase()}) — Price`;
    document.getElementById('chart-coin-info').innerHTML = `<div style="font-family:var(--mono);font-size:13px;font-weight:700;color:var(--text)">${fmtPrice(coin.current_price)}</div>`;
  }
  try {
    const data = await fetchHistory(id, STATE.chartTf);
    renderPriceChart(data, coin);
    renderSubCharts(data);
  } catch(e) { console.warn('Chart data failed', e); }
}

function renderPriceChart(data, coin) {
  if(!data?.prices) return;
  const prices = data.prices.map(p=>p[1]);
  const labels = data.prices.map(p=>new Date(p[0]));
  const up = prices[prices.length-1] >= prices[0];

  const datasets = [];
  const gradCanvas = document.getElementById('price-chart');
  const gradCtx = gradCanvas?.getContext('2d');
  let grad = null;
  if(gradCtx) {
    grad = gradCtx.createLinearGradient(0,0,0,300);
    if(up){grad.addColorStop(0,'rgba(0,230,118,0.2)');grad.addColorStop(1,'rgba(0,230,118,0)');}
    else{grad.addColorStop(0,'rgba(255,61,90,0.2)');grad.addColorStop(1,'rgba(255,61,90,0)');}
  }

  // Main price line
  datasets.push({ label:'Price', data:prices, borderColor:up?'#00e676':'#ff3d5a', borderWidth:2, pointRadius:0, fill:true, backgroundColor:grad||'transparent', tension:0.3, yAxisID:'y', order:10 });

  if(STATE.overlays.sma) {
    const s20=sma(prices,Math.min(20,prices.length)), s50=sma(prices,Math.min(50,prices.length));
    datasets.push({label:'SMA20',data:s20,borderColor:'#ffab00',borderWidth:1,pointRadius:0,borderDash:[],tension:0,yAxisID:'y',order:5});
    datasets.push({label:'SMA50',data:s50,borderColor:'#b060ff',borderWidth:1,pointRadius:0,borderDash:[4,4],tension:0,yAxisID:'y',order:5});
  }
  if(STATE.overlays.ema) {
    const e12=ema(prices,12), e26=ema(prices,26);
    datasets.push({label:'EMA12',data:e12,borderColor:'#00d4ff',borderWidth:1,pointRadius:0,borderDash:[],tension:0,yAxisID:'y',order:5});
    datasets.push({label:'EMA26',data:e26,borderColor:'#0099cc',borderWidth:1,pointRadius:0,borderDash:[2,3],tension:0,yAxisID:'y',order:5});
  }
  if(STATE.overlays.bb) {
    const bb=bollingerBands(prices);
    datasets.push({label:'BB Upper',data:bb.upper,borderColor:'rgba(100,120,140,0.5)',borderWidth:1,pointRadius:0,fill:false,borderDash:[3,3],yAxisID:'y',order:4});
    datasets.push({label:'BB Lower',data:bb.lower,borderColor:'rgba(100,120,140,0.5)',borderWidth:1,pointRadius:0,fill:false,borderDash:[3,3],yAxisID:'y',order:4});
    datasets.push({label:'BB Mid',data:bb.middle,borderColor:'rgba(100,120,140,0.3)',borderWidth:1,pointRadius:0,fill:false,yAxisID:'y',order:4});
  }

  const legendItems = datasets.slice(1,5).map((d,i)=>{
    const colors=['#ffab00','#b060ff','#00d4ff','#0099cc'];
    return `<div class="cov-item"><span class="cov-dot" style="background:${d.borderColor}"></span><span class="cov-label">${d.label}</span></div>`;
  }).join('');
  const legEl = document.getElementById('chart-legend');
  if(legEl) legEl.innerHTML = legendItems;

  makeOrUpdate('price-chart',{
    type:'line',
    data:{labels,datasets},
    options:{
      responsive:true, animation:false,
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{display:false},
        tooltip:{
          backgroundColor:'rgba(10,16,24,0.95)',
          borderColor:'var(--border2)',
          borderWidth:1,
          titleFont:{family:'IBM Plex Mono',size:10},
          bodyFont:{family:'IBM Plex Mono',size:10},
          callbacks:{
            title:ctx=>ctx[0].parsed.x instanceof Date?ctx[0].parsed.x.toLocaleDateString():labels[ctx[0].dataIndex]?.toLocaleDateString()||'',
            label:ctx=>`${ctx.dataset.label}: ${fmtPrice(ctx.raw)}`
          }
        }
      },
      scales:{
        x:{type:'category',display:true,ticks:{maxRotation:0,maxTicksLimit:8,color:'#4a6070',font:{size:9}},grid:{color:'rgba(26,42,61,0.5)'}},
        y:{position:'right',ticks:{color:'#4a6070',font:{size:9},callback:v=>fmtPrice(v)},grid:{color:'rgba(26,42,61,0.5)'}}
      }
    }
  });
}

function renderSubCharts(data) {
  if(!data?.prices) return;
  const prices = data.prices.map(p=>p[1]);
  const labels = data.prices.map(p=>new Date(p[0]));
  const vols = data.total_volumes?.map(v=>v[1])||[];

  // Volume
  if(STATE.overlays.vol && document.getElementById('vol-panel')) {
    document.getElementById('vol-panel').style.display='block';
    makeOrUpdate('vol-chart',{
      type:'bar',
      data:{labels,datasets:[{label:'Volume',data:vols,backgroundColor:prices.map((p,i)=>i>0&&p>=prices[i-1]?'rgba(0,230,118,0.5)':'rgba(255,61,90,0.5)'),borderColor:'transparent'}]},
      options:{responsive:true,animation:false,plugins:{legend:{display:false},tooltip:{enabled:false}},scales:{x:{display:false},y:{position:'right',ticks:{color:'#4a6070',font:{size:9},callback:v=>fmtCap(v)},grid:{color:'rgba(26,42,61,0.3)'}}}}
    });
  } else { const p=document.getElementById('vol-panel'); if(p) p.style.display='none'; }

  // RSI
  if(STATE.subs.rsi) {
    document.getElementById('rsi-panel').style.display='block';
    const rsiData = rsiCalc(prices,14);
    makeOrUpdate('rsi-chart',{
      type:'line',
      data:{labels,datasets:[
        {label:'RSI',data:rsiData,borderColor:'#00d4ff',borderWidth:1.5,pointRadius:0,fill:false,tension:0.3},
        {label:'OB',data:Array(labels.length).fill(70),borderColor:'rgba(255,61,90,0.4)',borderWidth:1,pointRadius:0,borderDash:[4,4]},
        {label:'OS',data:Array(labels.length).fill(30),borderColor:'rgba(0,230,118,0.4)',borderWidth:1,pointRadius:0,borderDash:[4,4]},
      ]},
      options:{responsive:true,animation:false,plugins:{legend:{display:false}},scales:{x:{display:false},y:{position:'right',min:0,max:100,ticks:{color:'#4a6070',font:{size:9},stepSize:25},grid:{color:'rgba(26,42,61,0.3)'}}}}
    });
  } else { document.getElementById('rsi-panel').style.display='none'; }

  // MACD
  if(STATE.subs.macd) {
    document.getElementById('macd-panel').style.display='block';
    const m = macdCalc(prices);
    const histColors = m.histogram.map(v=>v===null?'transparent':v>=0?'rgba(0,230,118,0.6)':'rgba(255,61,90,0.6)');
    makeOrUpdate('macd-chart',{
      type:'bar',
      data:{labels,datasets:[
        {label:'Histogram',data:m.histogram,backgroundColor:histColors,type:'bar',order:2},
        {label:'MACD',data:m.macdLine,borderColor:'#00d4ff',borderWidth:1.5,pointRadius:0,type:'line',order:1,fill:false,tension:0.3},
        {label:'Signal',data:m.signalLine,borderColor:'#ffab00',borderWidth:1,pointRadius:0,type:'line',order:1,fill:false,tension:0.3},
      ]},
      options:{responsive:true,animation:false,plugins:{legend:{display:false}},scales:{x:{display:false},y:{position:'right',ticks:{color:'#4a6070',font:{size:9}},grid:{color:'rgba(26,42,61,0.3)'}}}}
    });
  } else { document.getElementById('macd-panel').style.display='none'; }
}

function toggleOverlay(k) {
  STATE.overlays[k] = !STATE.overlays[k];
  document.getElementById('tog-'+k)?.classList.toggle('active', STATE.overlays[k]);
  loadChartData(STATE.selectedChartCoin);
}
function toggleSub(k) {
  STATE.subs[k] = !STATE.subs[k];
  document.getElementById('tog-'+k)?.classList.toggle('active', STATE.subs[k]);
  loadChartData(STATE.selectedChartCoin);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PREDICTIONS TAB
// ═══════════════════════════════════════════════════════════════════════════════
async function loadPrediction(coinId) {
  STATE.selectedPredCoin = coinId;
  const coin = STATE.coins.find(c=>c.id===coinId);
  document.getElementById('pred-coin-name').textContent = coin ? `${coin.name} (${coin.symbol.toUpperCase()})` : coinId;
  document.getElementById('pred-coin-price').textContent = coin ? fmtPrice(coin.current_price) : '—';

  try {
    const data = await fetchHistory(coinId, 90);
    if (!data?.prices) return;
    const prices = data.prices.map(p=>p[1]);
    const volumes = data.total_volumes?.map(v=>v[1])||[];
    const analysis = analyzeSignals(prices, volumes);
    if (!analysis) return;

    // Big signal
    const badge = document.getElementById('pred-badge');
    badge.textContent = analysis.signal;
    badge.style.color = signalColor(analysis.signal);
    document.getElementById('pred-score').textContent = analysis.normalizedScore.toFixed(1);
    const bar = document.getElementById('pred-score-bar');
    bar.style.width = (analysis.normalizedScore*10)+'%';
    bar.style.background = signalColor(analysis.signal);

    // Price targets
    const cur = prices[prices.length-1];
    document.getElementById('pt-bear').textContent = fmtPrice(analysis.bearTarget);
    document.getElementById('pt-bear-chg').textContent = fmtPct((analysis.bearTarget-cur)/cur*100);
    document.getElementById('pt-base').textContent = fmtPrice(analysis.lrTarget);
    document.getElementById('pt-base-chg').textContent = fmtPct((analysis.lrTarget-cur)/cur*100);
    const basechg = (analysis.lrTarget-cur)/cur*100;
    document.getElementById('pt-base-chg').className = 'pt-chg '+(basechg>=0?'up':'down');
    document.getElementById('pt-bull').textContent = fmtPrice(analysis.bullTarget);
    document.getElementById('pt-bull-chg').textContent = fmtPct((analysis.bullTarget-cur)/cur*100);

    renderRegressionChart(data, analysis, coin);
    renderIndicatorCards(analysis.indicators);
    renderRadarChart(analysis.indicators);

    // Log signal
    addToSignalLog(coin?.symbol?.toUpperCase()||coinId, analysis.signal, coin?.current_price);

  } catch(e) { console.warn('Prediction error', e); }
}

function renderRegressionChart(data, analysis, coin) {
  const prices = data.prices.map(p=>p[1]);
  const labels = data.prices.map(p=>new Date(p[0]));
  const n = prices.length;
  const lr = analysis.lr;

  // Regression line over historical
  const regLine = prices.map((_,i)=>lr.predict(i));

  // Future 7 days
  const futurePrices = [], futureLabels = [];
  for(let i=1; i<=7; i++) {
    futureLabels.push(new Date(data.prices[n-1][0] + i*86400000));
    futurePrices.push(lr.predict(n-1+i));
  }
  const allLabels=[...labels,...futureLabels];
  const allData=[...prices,...Array(7).fill(null)];
  const allReg=[...regLine,...futurePrices];
  const bullArr=[...Array(n).fill(null),...Array(7).fill(null).map((_,i)=>lr.predict(n-1+i)+stdev(prices.slice(-30))*(0.5+i*0.1))];
  const bearArr=[...Array(n).fill(null),...Array(7).fill(null).map((_,i)=>lr.predict(n-1+i)-stdev(prices.slice(-30))*(0.5+i*0.1))];

  makeOrUpdate('regression-chart',{
    type:'line',
    data:{labels:allLabels,datasets:[
      {label:'Price',data:allData,borderColor:coin?.price_change_percentage_24h>=0?'#00e676':'#ff3d5a',borderWidth:1.5,pointRadius:0,fill:false,tension:0.3},
      {label:'Regression',data:allReg,borderColor:'#ffab00',borderWidth:1.5,pointRadius:0,fill:false,borderDash:[6,3],tension:0},
      {label:'Bull',data:bullArr,borderColor:'rgba(0,230,118,0.5)',borderWidth:1,pointRadius:0,fill:false,borderDash:[3,3],tension:0.3},
      {label:'Bear',data:bearArr,borderColor:'rgba(255,61,90,0.5)',borderWidth:1,pointRadius:0,fill:false,borderDash:[3,3],tension:0.3},
    ]},
    options:{responsive:true,animation:false,plugins:{legend:{display:false}},scales:{x:{type:'category',display:true,ticks:{maxRotation:0,maxTicksLimit:8,color:'#4a6070',font:{size:9}},grid:{color:'rgba(26,42,61,0.3)'}},y:{position:'right',ticks:{color:'#4a6070',font:{size:9},callback:v=>fmtPrice(v)},grid:{color:'rgba(26,42,61,0.3)'}}}}
  });
}

function renderIndicatorCards(indicators) {
  const grid = document.getElementById('indicators-grid');
  grid.innerHTML = indicators.map(ind=>{
    const color = signalColor(ind.signal);
    const score = ind.score;
    const barW = Math.max(0,Math.min(100,((score+2)/4)*100));
    const barColor = score>0?'var(--green)':score<0?'var(--red)':'var(--text3)';
    return `<div class="ind-card">
      <div class="ind-name">${ind.name}</div>
      <div class="ind-value" style="color:${color}">${ind.value}</div>
      <div class="ind-signal" style="color:${color}">${ind.signal}</div>
      <div class="ind-desc">${ind.desc}</div>
      <div class="ind-bar" style="background:var(--bg4);border-radius:2px;height:3px;margin-top:8px;overflow:hidden">
        <div style="width:${barW}%;height:100%;background:${barColor};border-radius:2px;transition:width 0.8s ease"></div>
      </div>
    </div>`;
  }).join('');
}

function renderRadarChart(indicators) {
  const labels = indicators.map(i=>i.name.split(' ')[0]);
  const data = indicators.map(i=>(i.score+2)/4*100); // 0-100
  makeOrUpdate('radar-chart',{
    type:'radar',
    data:{labels,datasets:[{data,backgroundColor:'rgba(0,212,255,0.15)',borderColor:'#00d4ff',borderWidth:1.5,pointBackgroundColor:'#00d4ff',pointRadius:3}]},
    options:{
      responsive:true,animation:false,
      plugins:{legend:{display:false}},
      scales:{r:{min:0,max:100,ticks:{display:false,stepSize:25},grid:{color:'rgba(26,42,61,0.8)'},pointLabels:{color:'#4a6070',font:{size:9,family:'IBM Plex Mono'}}}}
    }
  });
}

async function renderMultiSignals() {
  const el = document.getElementById('multi-signals');
  if(!el) return;
  const topCoins = STATE.coins.slice(0,8);
  const rows = topCoins.map(c=>{
    const sig = quickSignal(c);
    const color = signalColor(sig);
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:7px 14px;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:11px;cursor:pointer" onclick="loadPrediction('${c.id}')">
      <span style="color:var(--cyan);font-weight:700">${c.symbol.toUpperCase()}</span>
      <span style="color:var(--text2)">${fmtPrice(c.current_price)}</span>
      <span style="color:${color};font-size:9px;font-weight:700">${sig}</span>
    </div>`;
  }).join('');
  el.innerHTML = rows;

  // Coin buttons
  const btns = topCoins.slice(0,6).map(c=>`<button class="btn ${c.id===STATE.selectedPredCoin?'active':''}" onclick="loadPrediction('${c.id}')">${c.symbol.toUpperCase()}</button>`).join('');
  const predBtns = document.getElementById('pred-coin-btns');
  if(predBtns) predBtns.innerHTML = btns;
}

function addToSignalLog(sym, sig, price) {
  const entry = { sym, sig, price, time:new Date().toLocaleTimeString() };
  STATE.signalLog.unshift(entry);
  if(STATE.signalLog.length > 20) STATE.signalLog.pop();
  renderSignalLog();
}

function renderSignalLog() {
  const logs = STATE.signalLog.slice(0,10);
  const mkEntry=e=>`<div class="signal-log-item">
    <span class="sl-time">${e.time}</span>
    <span class="sl-coin">${e.sym}</span>
    <span style="color:${signalColor(e.sig)};font-weight:700;min-width:100px">${e.sig}</span>
    <span class="sl-msg">${fmtPrice(e.price)}</span>
  </div>`;
  const sl1 = document.getElementById('signal-log');
  const sl2 = document.getElementById('pred-signal-log');
  const html = logs.length ? logs.map(mkEntry).join('') : '<div class="empty-state">No signals yet</div>';
  if(sl1) sl1.innerHTML = html;
  if(sl2) sl2.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PORTFOLIO
// ═══════════════════════════════════════════════════════════════════════════════
function buildCoinSelects() {
  const opts = STATE.coins.map(c=>`<option value="${c.id}">${c.symbol.toUpperCase()} — ${c.name}</option>`).join('');
  const selects = ['port-coin-select','watch-coin-select'];
  selects.forEach(id=>{ const el=document.getElementById(id); if(el) el.innerHTML=opts; });
}

function addPortfolioEntry() {
  const coinId = document.getElementById('port-coin-select').value;
  const amount = parseFloat(document.getElementById('port-amount').value);
  const buyPrice = parseFloat(document.getElementById('port-buy-price').value);
  const date = document.getElementById('port-date').value || new Date().toISOString().split('T')[0];
  if(!coinId||!amount||!buyPrice||isNaN(amount)||isNaN(buyPrice)) { showToast('Please fill in all fields'); return; }
  const coin = STATE.coins.find(c=>c.id===coinId);
  STATE.portfolio.push({ coinId, amount, buyPrice, date, name:coin?.name||coinId, symbol:coin?.symbol?.toUpperCase()||coinId });
  localStorage.setItem('cv_portfolio', JSON.stringify(STATE.portfolio));
  updatePortfolio();
  showToast(`Added ${amount} ${coin?.symbol?.toUpperCase()||coinId} to portfolio`);
}

function removePortfolioEntry(idx) {
  STATE.portfolio.splice(idx, 1);
  localStorage.setItem('cv_portfolio', JSON.stringify(STATE.portfolio));
  updatePortfolio();
}

function updatePortfolio() {
  let totalValue=0, totalCost=0;
  const enriched = STATE.portfolio.map((entry,i)=>{
    const coin = STATE.coins.find(c=>c.id===entry.coinId);
    const cur = coin?.current_price||0;
    const value = entry.amount * cur;
    const cost = entry.amount * entry.buyPrice;
    const pnl = value - cost;
    const pnlPct = cost ? (pnl/cost)*100 : 0;
    totalValue += value; totalCost += cost;
    return {...entry, currentPrice:cur, value, cost, pnl, pnlPct};
  });

  const totalPnl = totalValue - totalCost;
  const totalPnlPct = totalCost ? (totalPnl/totalCost)*100 : 0;

  document.getElementById('port-total').textContent = fmtCap(totalValue);
  document.getElementById('port-cost').textContent = fmtCap(totalCost);
  const pnlEl = document.getElementById('port-pnl');
  pnlEl.textContent = (totalPnl>=0?'+':'')+fmtCap(totalPnl);
  pnlEl.className = 'ps-val '+(totalPnl>=0?'up':'down');
  const pnlPctEl = document.getElementById('port-pnl-pct');
  pnlPctEl.textContent = fmtPct(totalPnlPct);
  pnlPctEl.className = 'ps-sub '+(totalPnlPct>=0?'up':'down');

  // Table
  const tbody = document.getElementById('port-tbody');
  if(enriched.length===0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No holdings yet. Add your first position.</td></tr>';
  } else {
    tbody.innerHTML = enriched.map((e,i)=>`<tr>
      <td><div style="display:flex;align-items:center;gap:8px"><span style="font-family:var(--mono);font-size:12px;font-weight:700;color:var(--cyan)">${e.symbol}</span><span style="font-family:var(--mono);font-size:10px;color:var(--text3)">${e.name}</span></div></td>
      <td style="font-family:var(--mono)">${e.amount.toLocaleString()}</td>
      <td style="font-family:var(--mono)">${fmtPrice(e.buyPrice)}</td>
      <td style="font-family:var(--mono)">${fmtPrice(e.currentPrice)}</td>
      <td style="font-family:var(--mono);font-weight:700">${fmtCap(e.value)}</td>
      <td class="pnl-cell ${e.pnl>=0?'up':'down'}" style="font-family:var(--mono)">${(e.pnl>=0?'+':'')}${fmtCap(e.pnl)}</td>
      <td class="pnl-cell ${e.pnlPct>=0?'up':'down'}" style="font-family:var(--mono)">${fmtPct(e.pnlPct)}</td>
      <td>${signalPill(quickSignal(STATE.coins.find(c=>c.id===e.coinId)||{}))}</td>
      <td><button class="del-btn" onclick="removePortfolioEntry(${i})">✕</button></td>
    </tr>`).join('');
  }

  renderAllocationChart(enriched);
  renderPnlChart(enriched);
}

function renderAllocationChart(enriched) {
  if(!enriched.length) { makeOrUpdate('alloc-chart',{type:'doughnut',data:{datasets:[{data:[1],backgroundColor:['#1a2a3d']}]},options:{cutout:'70%',plugins:{legend:{display:false}}}}); return; }
  const colors = ['#00d4ff','#00e676','#ff3d5a','#ffab00','#b060ff','#ff7043','#a3d977','#4dd0e1'];
  const labels = enriched.map(e=>e.symbol);
  const data = enriched.map(e=>e.value);
  const total = data.reduce((a,b)=>a+b,0);
  document.getElementById('alloc-total').textContent = fmtCap(total);
  makeOrUpdate('alloc-chart',{
    type:'doughnut',
    data:{labels,datasets:[{data,backgroundColor:colors.map((c,i)=>c+(i<enriched.length?'cc':'33')),borderColor:colors,borderWidth:1}]},
    options:{cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.label}: ${fmtCap(ctx.raw)} (${((ctx.raw/total)*100).toFixed(1)}%)`}}}}
  });
  const legend = document.getElementById('alloc-legend');
  legend.innerHTML = enriched.map((e,i)=>`<div class="alloc-item">
    <div class="alloc-dot" style="background:${colors[i%colors.length]}"></div>
    <span class="alloc-name">${e.symbol}</span>
    <span class="alloc-pct">${((e.value/total)*100).toFixed(1)}%</span>
  </div>`).join('');
}

function renderPnlChart(enriched) {
  if(!enriched.length) return;
  const labels = enriched.map(e=>e.symbol);
  const data = enriched.map(e=>e.pnlPct);
  const colors = data.map(v=>v>=0?'rgba(0,230,118,0.7)':'rgba(255,61,90,0.7)');
  const borders = data.map(v=>v>=0?'#00e676':'#ff3d5a');
  makeOrUpdate('pnl-chart',{
    type:'bar',
    data:{labels,datasets:[{label:'P&L %',data,backgroundColor:colors,borderColor:borders,borderWidth:1}]},
    options:{responsive:true,indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#4a6070',font:{size:9},callback:v=>v.toFixed(1)+'%'},grid:{color:'rgba(26,42,61,0.3)'}},y:{ticks:{color:'#8aabb0',font:{size:9,family:'IBM Plex Mono'}},grid:{display:false}}}}
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALERTS
// ═══════════════════════════════════════════════════════════════════════════════
function showAddAlert() {
  const coinId = STATE.coins[0]?.id||'bitcoin';
  const price = prompt('Set alert — enter: COIN_ID,TARGET_PRICE,above/below\nExample: bitcoin,50000,above');
  if(!price) return;
  const parts = price.split(',');
  if(parts.length<3) { showToast('Invalid format'); return; }
  const [id,targetStr,dir] = parts;
  const target = parseFloat(targetStr);
  if(isNaN(target)) { showToast('Invalid price'); return; }
  const coin = STATE.coins.find(c=>c.id===id||c.symbol.toLowerCase()===id.toLowerCase());
  STATE.alerts.push({ coinId:coin?.id||id, symbol:coin?.symbol?.toUpperCase()||id.toUpperCase(), target, dir:dir.trim().toLowerCase(), triggered:false });
  localStorage.setItem('cv_alerts', JSON.stringify(STATE.alerts));
  renderAlerts();
}

function renderAlerts() {
  const el = document.getElementById('alerts-list');
  if(!STATE.alerts.length){el.innerHTML='<div class="empty-state">No alerts set. Click + Add Alert.</div>';return;}
  el.innerHTML = STATE.alerts.map((a,i)=>`<div class="alert-row ${a.triggered?'triggered':''}">
    <span class="alert-icon">${a.triggered?'🔔':'⏰'}</span>
    <span class="alert-text"><strong style="color:var(--cyan)">${a.symbol}</strong> ${a.dir==='above'?'rises above':'falls below'} <span class="alert-val">${fmtPrice(a.target)}</span></span>
    <button class="del-btn" onclick="removeAlert(${i})">✕</button>
  </div>`).join('');
}

function removeAlert(i) { STATE.alerts.splice(i,1); localStorage.setItem('cv_alerts',JSON.stringify(STATE.alerts)); renderAlerts(); }

function checkAlerts() {
  STATE.alerts.forEach(a=>{
    const coin = STATE.coins.find(c=>c.id===a.coinId);
    if(!coin||a.triggered) return;
    const cur = coin.current_price;
    if((a.dir==='above'&&cur>=a.target)||(a.dir==='below'&&cur<=a.target)) {
      a.triggered = true;
      showToast(`🔔 ALERT: ${a.symbol} is now ${fmtPrice(cur)} (target: ${fmtPrice(a.target)})`);
    }
  });
  localStorage.setItem('cv_alerts',JSON.stringify(STATE.alerts));
  renderAlerts();
}

// ═══════════════════════════════════════════════════════════════════════════════
// WATCHLIST
// ═══════════════════════════════════════════════════════════════════════════════
function addToWatchlist() {
  const id = document.getElementById('watch-coin-select').value;
  if(!id||STATE.watchlist.includes(id)) { showToast('Already watching'); return; }
  STATE.watchlist.push(id);
  localStorage.setItem('cv_watchlist', JSON.stringify(STATE.watchlist));
  renderWatchlist();
  showToast(`Added to watchlist`);
}

function removeFromWatchlist(id) {
  STATE.watchlist = STATE.watchlist.filter(w=>w!==id);
  localStorage.setItem('cv_watchlist', JSON.stringify(STATE.watchlist));
  renderWatchlist();
}

function renderWatchlist() {
  const grid = document.getElementById('watch-grid');
  if(!grid) return;
  const coins = STATE.coins.filter(c=>STATE.watchlist.includes(c.id));
  if(!coins.length) { grid.innerHTML='<div class="empty-state">No coins being watched. Add some above.</div>'; return; }
  grid.innerHTML = coins.map(c=>{
    const chg24=c.price_change_percentage_24h||0;
    const chg7=c.price_change_percentage_7d_in_currency||0;
    const spark=c.sparkline_in_7d?.price||[];
    const note=STATE.watchNotes[c.id]||'';
    const sig = quickSignal(c);
    return `<div class="watch-card">
      <button class="remove-watch" onclick="removeFromWatchlist('${c.id}')">✕</button>
      <div class="watch-card-top">
        <div class="wc-coin">
          <div class="coin-icon"><img src="${c.image}" onerror="this.style.display='none'" style="width:100%;height:100%"></div>
          <div><div class="wc-sym">${c.symbol.toUpperCase()}</div><div class="wc-name">${c.name}</div></div>
        </div>
        ${signalPill(sig)}
      </div>
      <div class="wc-price">${fmtPrice(c.current_price)}</div>
      <div class="wc-changes">
        <div class="wc-chg"><div class="wc-chg-label">1H</div><span class="${pctClass(c.price_change_percentage_1h_in_currency||0)}">${fmtPct(c.price_change_percentage_1h_in_currency||0)}</span></div>
        <div class="wc-chg"><div class="wc-chg-label">24H</div><span class="${pctClass(chg24)}">${fmtPct(chg24)}</span></div>
        <div class="wc-chg"><div class="wc-chg-label">7D</div><span class="${pctClass(chg7)}">${fmtPct(chg7)}</span></div>
      </div>
      <canvas width="240" height="50" id="wsp-${c.id}" class="watch-sparkline"></canvas>
      <div class="wc-stats">
        <div class="wcs"><span class="wcs-l">MCap </span><span class="wcs-v">${fmtCap(c.market_cap)}</span></div>
        <div class="wcs"><span class="wcs-l">Vol24h </span><span class="wcs-v">${fmtCap(c.total_volume)}</span></div>
        <div class="wcs"><span class="wcs-l">H24 </span><span class="wcs-v">${fmtPrice(c.high_24h)}</span></div>
        <div class="wcs"><span class="wcs-l">L24 </span><span class="wcs-v">${fmtPrice(c.low_24h)}</span></div>
      </div>
      <div class="add-note">Notes</div>
      <textarea class="note-input" rows="2" placeholder="Add notes…" onchange="saveNote('${c.id}',this.value)">${note}</textarea>
    </div>`;
  }).join('');
  // Sparklines
  coins.forEach(c=>{
    const spark=c.sparkline_in_7d?.price||[];
    const canvas=document.getElementById('wsp-'+c.id);
    if(canvas&&spark.length) drawSparkline(canvas,spark,c.price_change_percentage_7d_in_currency>=0);
  });
}

function saveNote(id, val) {
  STATE.watchNotes[id]=val;
  localStorage.setItem('cv_watch_notes',JSON.stringify(STATE.watchNotes));
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAV & TABS
// ═══════════════════════════════════════════════════════════════════════════════
function switchTab(id) {
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===id));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active',p.id==='tab-'+id));
  if(id==='predictions') renderMultiSignals();
  if(id==='portfolio') { updatePortfolio(); renderAlerts(); }
  if(id==='watchlist') renderWatchlist();
}

document.querySelectorAll('.nav-tab').forEach(t=>t.addEventListener('click',()=>switchTab(t.dataset.tab)));

document.querySelectorAll('[data-tf]').forEach(btn=>{
  btn.addEventListener('click',()=>{
    STATE.chartTf = parseInt(btn.dataset.tf);
    document.querySelectorAll('[data-tf]').forEach(b=>b.classList.toggle('active',b===btn));
    loadChartData(STATE.selectedChartCoin);
  });
});

document.getElementById('coin-search')?.addEventListener('input', renderCoinsTable);
document.getElementById('chart-search')?.addEventListener('input', e=>{
  const q=e.target.value.toLowerCase();
  document.querySelectorAll('.coin-list-item').forEach(el=>{
    const sym=el.querySelector('.cli-sym')?.textContent?.toLowerCase()||'';
    el.style.display=!q||sym.includes(q)?'':'none';
  });
});

function showToast(msg) {
  const t=document.getElementById('toast');
  t.textContent=msg; t.style.display='block';
  setTimeout(()=>t.style.display='none',3000);
}

async function refreshData() {
  await loadMarkets();
  if(STATE.selectedChartCoin) await loadChartData(STATE.selectedChartCoin);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════
const loadingMessages = [
  'Connecting to market data feeds...',
  'Calibrating prediction algorithms...',
  'Loading technical indicators...',
  'Initializing chart engine...',
  'Ready!'
];
let msgIdx=0;
const msgEl=document.getElementById('loading-msg');
const msgInterval=setInterval(()=>{
  if(msgIdx<loadingMessages.length) { msgEl.textContent=loadingMessages[msgIdx++]; }
  else clearInterval(msgInterval);
},500);

// Set today's date default
const dateInput=document.getElementById('port-date');
if(dateInput) dateInput.value=new Date().toISOString().split('T')[0];

async function init() {
  try {
    await Promise.all([loadMarkets(), loadFNG(), loadGlobal()]);
    if(STATE.coins.length>0) {
      await loadChartData(STATE.selectedChartCoin);
      await loadPrediction(STATE.selectedPredCoin);
    }
  } catch(e) { console.warn('Init error', e); }
  // Hide loading
  const ov=document.getElementById('loading-overlay');
  ov.style.opacity='0'; setTimeout(()=>ov.style.display='none',500);
  // Auto-refresh every 60s
  setInterval(async()=>{
    await loadMarkets();
    await loadFNG();
    if(STATE.selectedChartCoin) loadChartData(STATE.selectedChartCoin);
  }, 60000);
}

init();
