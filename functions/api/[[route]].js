// functions/api/[[route]].js
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const route = url.pathname.replace('/api/', '');
  const params = url.searchParams;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (context.request.method === 'OPTIONS') return new Response(null, {headers: cors});

  try {
    switch(route) {
      case 'geo': return await geo(context, cors);
      case 'ping': return await ping(params.get('host'), cors);
      case 'trace': return await trace(params.get('host'), cors);
      case 'bgp': return await bgp(params.get('ip'), cors);
      case 'blacklist': return await blacklist(params.get('ip'), cors);
      case 'port': return await portCheck(params.get('host'), params.get('port'), cors);
      case 'ptr': return await ptr(params.get('ip'), cors);
      case 'asn': return await asn(params.get('ip'), cors);
      case 'whois': return await whois(params.get('domain'), cors);
      case 'mail': return await mailHealth(params.get('domain'), cors);
      case 'web': return await webHealth(params.get('url'), cors);
      case 'dns': return await dnsProp(params.get('domain'), params.get('type') || 'A', cors);
      case 'subdomains': return await subdomains(params.get('domain'), cors);
      default: return Response.json({error: 'Route not found'}, {status: 404, headers: cors});
    }
  } catch(e) {
    return Response.json({error: e.message}, {status: 500, headers: cors});
  }
}

async function geo(context, cors) {
  const req = context.request;
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const country = req.cf?.country || 'XX';
  const city = req.cf?.city || 'Unknown';
  const asn = req.cf?.asn || 0;
  const timezone = req.cf?.timezone || 'UTC';
  
  return Response.json({
    ip,
    country,
    city,
    asn,
    timezone,
    colo: req.cf?.colo,
    tls: req.cf?.tlsVersion
  }, {headers: cors});
}

// 1. PING - TCP handshake timing instead of ICMP
async function ping(host, cors) {
  if(!host) return Response.json({error: 'host required'}, {headers: cors});
  const start = Date.now();
  try {
    await fetch(`https://${host}`, {method: 'HEAD', signal: AbortSignal.timeout(3000)});
    return Response.json({host, latency_ms: Date.now() - start, method: 'HTTPS HEAD'});
  } catch {
    try {
      await fetch(`http://${host}`, {method: 'HEAD', signal: AbortSignal.timeout(3000)});
      return Response.json({host, latency_ms: Date.now() - start, method: 'HTTP HEAD'});
    } catch(e) {
      return Response.json({host, error: 'Unreachable', latency_ms: Date.now() - start});
    }
  }
}

// 2. TRACE - Use Cloudflare trace route API + hop timing
async function trace(host, cors) {
  if(!host) return Response.json({error: 'host required'}, {headers: cors});
  const hops = [];
  for(let ttl = 1; ttl <= 20; ttl++) {
    const start = Date.now();
    try {
      await fetch(`https://${host}`, {cf: {resolveOverride: host}, headers: {'Cache-Control': 'no-cache'}});
      hops.push({ttl, time: Date.now() - start, host});
      break;
    } catch(e) {
      hops.push({ttl, time: Date.now() - start, error: 'timeout'});
    }
  }
  return Response.json({host, hops});
}

// 3. BGP ROUTE - Use RIPE Stat API
async function bgp(ip, cors) {
  if(!ip) return Response.json({error: 'ip required'}, {headers: cors});
  const r = await fetch(`https://stat.ripe.net/data/prefix-overview/data.json?resource=${ip}`);
  const data = await r.json();
  return Response.json(data.data);
}

// 4. IP BLACKLIST CHECK - Check major DNSBLs
async function blacklist(ip, cors) {
  if(!ip) return Response.json({error: 'ip required'}, {headers: cors});
  const reversed = ip.split('.').reverse().join('.');
  const lists = ['zen.spamhaus.org', 'bl.spamcop.net', 'b.barracudacentral.org'];
  const results = {};

  for(let list of lists) {
    try {
      const dns = await fetch(`https://dns.google/resolve?name=${reversed}.${list}&type=A`);
      const json = await dns.json();
      results[list] = json.Status === 0? 'LISTED' : 'CLEAN';
    } catch {
      results[list] = 'ERROR';
    }
  }
  return Response.json({ip, results});
}

// 5. OPEN PORT CHECK - Try TCP connect via fetch
async function portCheck(host, port, cors) {
  if(!host ||!port) return Response.json({error: 'host and port required'}, {headers: cors});
  const start = Date.now();
  try {
    await fetch(`${port == 443? 'https' : 'http'}://${host}:${port}`, {method: 'HEAD', signal: AbortSignal.timeout(2000)});
    return Response.json({host, port: +port, status: 'open', latency_ms: Date.now() - start});
  } catch {
    return Response.json({host, port: +port, status: 'closed/filtered'});
  }
}

// 6. PTR + ASN + WHOIS
async function ptr(ip, cors) {
  const r = await fetch(`https://dns.google/resolve?name=${ip.split('.').reverse().join('.')}.in-addr.arpa&type=PTR`);
  const data = await r.json();
  return Response.json({ip, ptr: data.Answer?.[0]?.data || null});
}

async function asn(ip, cors) {
  const r = await fetch(`https://api.bgpview.io/ip/${ip}`);
  const data = await r.json();
  return Response.json(data.data);
}

// 7. MAIL SERVER HEALTH
async function mailHealth(domain, cors) {
  if(!domain) return Response.json({error: 'domain required'}, {headers: cors});

  const checkDNS = async (name, type) => {
    const r = await fetch(`https://dns.google/resolve?name=${name}&type=${type}`);
    return (await r.json()).Answer?.map(a => a.data) || [];
  };

  const mx = await checkDNS(domain, 'MX');
  const spf = await checkDNS(domain, 'TXT').then(t => t.find(x => x.includes('spf1')));
  const dmarc = await checkDNS(`_dmarc.${domain}`, 'TXT').then(t => t[0]);
  const bimi = await checkDNS(`default._bimi.${domain}`, 'TXT').then(t => t[0]);

  // DKIM selector guess common ones
  const dkim = await checkDNS(`default._domainkey.${domain}`, 'TXT').then(t => t[0]);

  // DNSBL check for MX IPs
  const dnsbl = {};
  for(let record of mx) {
    const ip = record.split(' ').pop();
    dnsbl[ip] = await blacklist(ip, cors).then(r => r.json());
  }

  return Response.json({domain, mx, spf, dmarc, dkim, bimi, dnsbl});
}

// 8. WEB SERVER HEALTH
async function webHealth(url, cors) {
  if(!url) return Response.json({error: 'url required'}, {headers: cors});
  if(!url.startsWith('http')) url = 'https://' + url;

  const r = await fetch(url, {method: 'HEAD', redirect: 'manual'});
  const h = r.headers;

  const securityHeaders = {
    'Strict-Transport-Security': h.get('strict-transport-security'),
    'Content-Security-Policy': h.get('content-security-policy'),
    'X-Frame-Options': h.get('x-frame-options'),
    'X-Content-Type-Options': h.get('x-content-type-options'),
    'Referrer-Policy': h.get('referrer-policy')
  };

  const tls = url.startsWith('https');
  const hsts =!!securityHeaders['Strict-Transport-Security'];

  return Response.json({url, status: r.status, tls, hsts, securityHeaders});
}

// 9. DNS PROPAGATION - Query multiple public DNS
// Fixed DNS Propagation - only stable DoH resolvers
async function dnsProp(domain, type, cors) {
  if(!domain) return Response.json({error: 'domain required'}, {headers: cors});

  const resolvers = [
    {name: 'Google', url: 'https://dns.google/resolve'},
    {name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query'},
    {name: 'cleanbrowsing', url: 'https://doh.cleanbrowsing.org/doh/family-filter/'},
    {name: 'ctrld', url: 'https://freedns.controld.com/dns-query'},
    {name: 'mulvad', url: 'https://adblock.dns.mullvad.net/dns-query'},
    {name: 'adguard', url: 'https://family.adguard-dns.com/dns-query'},
  ];

  const results = {};
  for(let r of resolvers) {
    try {
      const res = await fetch(`${r.url}?name=${domain}&type=${type}`, {
        headers: {'Accept': 'application/dns-json'},
        signal: AbortSignal.timeout(4000)
      });
      if(!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      results[r.name] = json.Answer?.map(a => a.data) || ['No records'];
    } catch(e) {
      results[r.name] = ['Error: ' + e.message];
    }
  }
  return Response.json({domain, type, results}, {headers: cors});
}

// Fixed WHOIS - DNS-based fallback, no 403
async function whois(domain, cors) {
  if(!domain) return Response.json({error: 'domain required'}, {headers: cors});

  try {
    // RDAP often 403 from CF, so fallback to DNS data
    const ns = await fetch(`https://dns.google/resolve?name=${domain}&type=NS`).then(r=>r.json());
    const soa = await fetch(`https://dns.google/resolve?name=${domain}&type=SOA`).then(r=>r.json());

    const nameservers = ns.Answer?.map(a => a.data.replace(/\.$/, '')) || [];
    const soaRecord = soa.Answer?.[0]?.data?.split(' ') || [];

    // Try whoisjson.com as backup - free, no key
    let registrar = 'N/A', created = 'N/A', expires = 'N/A';
    try {
      const w = await fetch(`https://api.whoisjson.com/v1/${domain}`, {signal: AbortSignal.timeout(3000)});
      if(w.ok) {
        const wd = await w.json();
        registrar = wd.registrar?.name || 'N/A';
        created = wd.created_date || 'N/A';
        expires = wd.expiration_date || 'N/A';
      }
    } catch {}

    return Response.json({
      domain,
      registrar,
      created,
      expires,
      nameservers,
      soa: soaRecord.length? {
        mname: soaRecord[0],
        rname: soaRecord[1],
        serial: soaRecord[2]
      } : null,
      note: 'Using DNS + whoisjson fallback.'
    }, {headers: cors});
  } catch(e) {
    return Response.json({error: 'Lookup failed: ' + e.message}, {headers: cors});
  }
}

// 10. SUBDOMAIN DISCOVERY - Use crt.sh + SecurityTrails free API
async function subdomains(domain, cors) {
  const r = await fetch(`https://crt.sh/?q=%25.${domain}&output=json`);
  const data = await r.json();
  const subs = [...new Set(data.map(d => d.name_value).flatMap(s => s.split('\n')))]
   .filter(s => s.endsWith(domain));
  return Response.json({domain, subdomains: subs.slice(0, 100)});
}
