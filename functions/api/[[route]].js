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
      case 'ping': return await ping(params.get('host'), cors);
      case 'port': return await portCheck(params.get('host'), params.get('port'), cors);
      case 'dns': return await dnsProp(params.get('domain'), params.get('type') || 'A', cors);
      case 'whois': return await whois(params.get('domain'), cors);
      case 'mail': return await mailHealth(params.get('domain'), cors);
      case 'web': return await webHealth(params.get('url'), cors);
      case 'subdomains': return await subdomains(params.get('domain'), cors);
      case 'geo': return await geo(context, params.get('ip'), cors);
      case 'asn': return await asn(params.get('ip'), context, cors);
      case 'ptr': return await ptr(params.get('ip'), context, cors);
      case 'blacklist': return await blacklist(params.get('ip'), context, cors);
      case 'bgp': return await bgp(params.get('ip'), context, cors);
      case 'trace': return await trace(params.get('host'), cors);
      default: return Response.json({error: 'Route not found. Use: ping, port, dns, whois, mail, web, subdomains, geo, asn, ptr, blacklist, bgp, trace'}, {status: 404, headers: cors});
    }
  } catch(e) {
    return Response.json({error: e.message}, {status: 500, headers: cors});
  }
}

// Helper: get IP from param or fallback to CF-Connecting-IP
function getIP(paramIP, context) {
  return paramIP || context.request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function ping(host, cors) {
  if(!host) return Response.json({error: 'host required'}, {headers: cors});
  const start = Date.now();
  try {
    await fetch(`https://${host}`, {method: 'HEAD', signal: AbortSignal.timeout(3000)});
    return Response.json({host, latency_ms: Date.now() - start, method: 'HTTPS HEAD'}, {headers: cors});
  } catch {
    try {
      await fetch(`http://${host}`, {method: 'HEAD', signal: AbortSignal.timeout(3000)});
      return Response.json({host, latency_ms: Date.now() - start, method: 'HTTP HEAD'}, {headers: cors});
    } catch(e) {
      return Response.json({host, error: 'Unreachable', latency_ms: Date.now() - start}, {headers: cors});
    }
  }
}

async function portCheck(host, port, cors) {
  if(!host ||!port) return Response.json({error: 'host and port required'}, {headers: cors});
  const start = Date.now();
  try {
    await fetch(`${port == 443? 'https' : 'http'}://${host}:${port}`, {method: 'HEAD', signal: AbortSignal.timeout(2000)});
    return Response.json({host, port: +port, status: 'open', latency_ms: Date.now() - start}, {headers: cors});
  } catch {
    return Response.json({host, port: +port, status: 'closed/filtered'}, {headers: cors});
  }
}

async function dnsProp(domain, type, cors) {
  if(!domain) return Response.json({error: 'domain required'}, {headers: cors});

  const resolvers = [
    {name: 'Google', url: 'https://dns.google/resolve'},
    {name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query'}
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

async function whois(domain, cors) {
  if(!domain) return Response.json({error: 'domain required'}, {headers: cors});

  try {
    const ns = await fetch(`https://dns.google/resolve?name=${domain}&type=NS`).then(r=>r.json());
    const soa = await fetch(`https://dns.google/resolve?name=${domain}&type=SOA`).then(r=>r.json());

    const nameservers = ns.Answer?.map(a => a.data.replace(/\.$/, '')) || [];
    const soaRecord = soa.Answer?.[0]?.data?.split(' ') || [];

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
      soa: soaRecord.length? {mname: soaRecord[0], rname: soaRecord[1], serial: soaRecord[2]} : null,
      note: 'RDAP blocked by provider. Using DNS + whoisjson fallback.'
    }, {headers: cors});
  } catch(e) {
    return Response.json({error: 'Lookup failed: ' + e.message}, {headers: cors});
  }
}

async function mailHealth(domain, cors) {
  if(!domain) return Response.json({error: 'domain required'}, {headers: cors});

  const checkDNS = async (name, type) => {
    const r = await fetch(`https://dns.google/resolve?name=${name}&type=${type}`);
    return (await r.json()).Answer?.map(a => a.data) || [];
  };

  const mx = await checkDNS(domain, 'MX');
  const spf = (await checkDNS(domain, 'TXT')).find(x => x.includes('spf1'));
  const dmarc = (await checkDNS(`_dmarc.${domain}`, 'TXT'))[0];
  const dkim = (await checkDNS(`default._domainkey.${domain}`, 'TXT'))[0];
  const bimi = (await checkDNS(`default._bimi.${domain}`, 'TXT'))[0];

  return Response.json({domain, mx, spf, dmarc, dkim, bimi}, {headers: cors});
}

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

  return Response.json({
    url,
    status: r.status,
    tls: url.startsWith('https'),
    hsts:!!securityHeaders['Strict-Transport-Security'],
    securityHeaders
  }, {headers: cors});
}

async function geo(context, ipParam, cors) {
  const ip = getIP(ipParam, context);
  const req = context.request;

  if(!ipParam || ip === req.headers.get('CF-Connecting-IP')) {
    return Response.json({
      ip,
      country: req.cf?.country || 'XX',
      city: req.cf?.city || 'Unknown',
      asn: req.cf?.asn || 0,
      timezone: req.cf?.timezone || 'UTC',
      colo: req.cf?.colo,
      tls: req.cf?.tlsVersion,
      source: 'Cloudflare'
    }, {headers: cors});
  } else {
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=status,message,country,city,query,org,as,timezone`);
    const data = await r.json();
    return Response.json({...data, source: 'ip-api.com'}, {headers: cors});
  }
}

async function asn(ipParam, context, cors) {
  const ip = getIP(ipParam, context);
  if(ip === 'unknown') return Response.json({error: 'IP required'}, {headers: cors});

  // BGPView blocks CF. Use ip-api.com + ipwhois.app as fallback
  const apis = [
    `http://ip-api.com/json/${ip}?fields=as,org,query`,
    `https://ipwho.is/${ip}`
  ];

  for(let url of apis) {
    try {
      const r = await fetch(url, {signal: AbortSignal.timeout(4000)});
      if(!r.ok) continue;
      const data = await r.json();

      if(data.as || data.asn) {
        return Response.json({
          ip,
          asn: data.as || data.asn,
          org: data.org || data.connection?.isp || 'N/A',
          source: url.includes('ip-api')? 'ip-api.com' : 'ipwho.is'
        }, {headers: cors});
      }
    } catch {}
  }
  return Response.json({error: 'ASN lookup failed for ' + ip}, {headers: cors});
}

async function subdomains(domain, cors) {
  if(!domain) return Response.json({error: 'domain required'}, {headers: cors});

  try {
    // crt.sh is slow. Use HackerTarget API - faster, no 502
    const r = await fetch(`https://api.hackertarget.com/hostsearch/?q=${domain}`, {signal: AbortSignal.timeout(8000)});
    if(!r.ok) throw new Error('HTTP ' + r.status);

    const text = await r.text();
    if(text.includes('error')) return Response.json({error: text}, {headers: cors});

    const subs = text.split('\n')
     .map(line => line.split(',')[0])
     .filter(s => s && s.endsWith(domain))
     .slice(0, 100);

    return Response.json({domain, count: subs.length, subdomains: subs, source: 'HackerTarget'}, {headers: cors});
  } catch(e) {
    return Response.json({error: 'Subdomain fetch failed: ' + e.message, domain}, {headers: cors});
  }
}

async function ptr(ipParam, context, cors) {
  const ip = getIP(ipParam, context);
  if(ip === 'unknown') return Response.json({error: 'IP required'}, {headers: cors});

  // 1. Try official DNS PTR first
  if(!ip.includes(':')) {
    const reversed = ip.split('.').reverse().join('.') + '.in-addr.arpa';
    try {
      const r = await fetch(`https://dns.google/resolve?name=${reversed}&type=PTR`, {
        headers: {'Accept': 'application/dns-json'},
        signal: AbortSignal.timeout(3000)
      });
      const json = await r.json();
      const ptrs = json.Answer?.filter(a => a.type === 12).map(a => a.data.replace(/\.$/, '')) || [];
      if(ptrs.length) {
        return Response.json({ip, source: 'DNS', ptr_count: ptrs.length, ptr: ptrs, status: 'found'}, {headers: cors});
      }
    } catch {}
  }

  // 2. Fallback: ip-api.com reverse field - not official DNS but shows hostname more often
  try {
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=reverse,query,status`, {signal: AbortSignal.timeout(3000)});
    const data = await r.json();
    if(data.status === 'success' && data.reverse && data.reverse !== ip) {
      return Response.json({
        ip, 
        source: 'ip-api.com', 
        ptr_count: 1, 
        ptr: [data.reverse], 
        status: 'found',
        note: 'Not official DNS PTR. Best-effort hostname from ip-api DB'
      }, {headers: cors});
    }
  } catch {}

  return Response.json({ip, source: 'none', ptr_count: 0, ptr: [], status: 'no_record'}, {headers: cors});
}

async function blacklist(ipParam, context, cors) {
  const ip = getIP(ipParam, context);
  if(ip === 'unknown') return Response.json({error: 'IP required'}, {headers: cors});

  const reversed = ip.split('.').reverse().join('.');
  const lists = {
    'zen.spamhaus.org': {
      '127.0.0.2': 'SBL - Spamhaus Block List',
      '127.0.0.3': 'CSS - Spamhaus Exploits',
      '127.0.0.4': 'SBL - Spamhaus Block List',
      '127.0.0.10': 'SBL + CSS',
      '127.0.0.11': 'SBL + CSS'
    },
    'bl.spamcop.net': {
      '127.0.0.2': 'SpamCop listed'
    },
    'b.barracudacentral.org' : {},
    'psbl.surriel.com' : {},
    'dnsbl.sorbs.net' : {},
    'truncate.gbudb.net' : {},
    'bl.mailspike.net' : {},
    'dnsbl-1.uceprotect.net' : {},
    'all.s5h.net' : {},
    'dnsbl.spfbl.net' : {},
    'combined.njabl.org' : {},
    'combined.abuse.ch' : {},
    'dnsbl.dronebl.org' : {},
  };

  const results = {};
  for(let list in lists) {
    try {
      const dns = await fetch(`https://dns.google/resolve?name=${reversed}.${list}&type=A`);
      const json = await dns.json();

      if(json.Status === 0 && json.Answer?.[0]?.data) {
        const code = json.Answer[0].data;
        results[list] = {
          status: 'LISTED',
          code: code,
          reason: lists[list][code] || 'Unknown listing code'
        };
      } else {
        results[list] = {status: 'CLEAN', code: null, reason: 'Not listed'};
      }
    } catch(e) {
      results[list] = {status: 'ERROR', code: null, reason: e.message};
    }
  }
  return Response.json({ip, results}, {headers: cors});
}

async function bgp(ipParam, context, cors) {
  const ip = getIP(ipParam, context);
  if(ip === 'unknown') return Response.json({error: 'IP required'}, {headers: cors});

  const r = await fetch(`https://stat.ripe.net/data/prefix-overview/data.json?resource=${ip}`);
  const data = await r.json();
  return Response.json({...data.data, requested_ip: ip}, {headers: cors});
}

async function trace(host, cors) {
  if(!host) return Response.json({error: 'host required'}, {headers: cors});
  const hops = [];
  for(let ttl = 1; ttl <= 10; ttl++) {
    const start = Date.now();
    try {
      await fetch(`https://${host}`, {signal: AbortSignal.timeout(1000)});
      hops.push({ttl, time: Date.now() - start});
      break;
    } catch {
      hops.push({ttl, time: Date.now() - start, error: 'timeout'});
    }
  }
  return Response.json({host, hops}, {headers: cors});
}
