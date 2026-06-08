export async function onRequest(context) {
  const url = new URL(context.request.url);
  const route = url.pathname.replace('/api/', '');
  const params = url.searchParams;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
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
      default: return new Response(JSON.stringify({error: 'Route not found'}, null, 2), {status: 404, headers: cors});
    }
  } catch(e) {
    return new Response(JSON.stringify({error: e.message}, null, 2), {status: 500, headers: cors});
  }
}

function getIP(paramIP, context) {
  return paramIP || context.request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function ping(host, cors) {
  if(!host) return new Response(JSON.stringify({error: 'host required'}, null, 2), {headers: cors});
  const start = Date.now();
  try {
    await fetch(`https://${host}`, {method: 'HEAD', signal: AbortSignal.timeout(3000)});
    return new Response(JSON.stringify({host, latency_ms: Date.now() - start, method: 'HTTPS HEAD'}, null, 2), {headers: cors});
  } catch {
    try {
      await fetch(`http://${host}`, {method: 'HEAD', signal: AbortSignal.timeout(3000)});
      return new Response(JSON.stringify({host, latency_ms: Date.now() - start, method: 'HTTP HEAD'}, null, 2), {headers: cors});
    } catch(e) {
      return new Response(JSON.stringify({host, error: 'Unreachable', latency_ms: Date.now() - start}, null, 2), {headers: cors});
    }
  }
}

async function portCheck(host, port, cors) {
  if(!host ||!port) return new Response(JSON.stringify({error: 'host and port required'}, null, 2), {headers: cors});
  const start = Date.now();
  try {
    await fetch(`${port == 443? 'https' : 'http'}://${host}:${port}`, {method: 'HEAD', signal: AbortSignal.timeout(2000)});
    return new Response(JSON.stringify({host, port: +port, status: 'open', latency_ms: Date.now() - start}, null, 2), {headers: cors});
  } catch {
    return new Response(JSON.stringify({host, port: +port, status: 'closed/filtered'}, null, 2), {headers: cors});
  }
}

async function dnsProp(domain, type, cors) {
  if(!domain) return new Response(JSON.stringify({error: 'domain required'}, null, 2), {headers: cors});

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
      const data = await res.json();
      results[r.name] = data.Answer?.map(a => a.data) || ['No records'];
    } catch(e) {
      results[r.name] = ['Error: ' + e.message];
    }
  }
  return new Response(JSON.stringify({domain, type, results}, null, 2), {headers: cors});
}

async function geo(context, ipParam, cors) {
  const ip = getIP(ipParam, context);
  const req = context.request;

  if(!ipParam || ip === req.headers.get('CF-Connecting-IP')) {
    return new Response(JSON.stringify({
      ip,
      country: req.cf?.country || 'XX',
      city: req.cf?.city || 'Unknown',
      lat: req.cf?.latitude,
      lon: req.cf?.longitude,
      asn: req.cf?.asn || 0,
      timezone: req.cf?.timezone || 'UTC',
      colo: req.cf?.colo,
      tls: req.cf?.tlsVersion,
      source: 'Cloudflare'
    }, null, 2), {headers: cors});
  } else {
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=status,message,country,city,query,org,as,timezone`);
    const data = await r.json();
    return new Response(JSON.stringify({...data, source: 'ip-api.com'}, null, 2), {headers: cors});
  }
}

async function asn(ipParam, context, cors) {
  const ip = getIP(ipParam, context);
  if(ip === 'unknown') return new Response(JSON.stringify({error: 'IP required'}, null, 2), {headers: cors});

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
        return new Response(JSON.stringify({
          ip,
          asn: data.as || data.asn,
          org: data.org || data.connection?.isp || 'N/A',
          source: url.includes('ip-api')? 'ip-api.com' : 'ipwho.is'
        }, null, 2), {headers: cors});
      }
    } catch {}
  }
  return new Response(JSON.stringify({error: 'ASN lookup failed for ' + ip}, null, 2), {headers: cors});
}

async function ptr(ipParam, context, cors) {
  const ip = getIP(ipParam, context);
  if(ip === 'unknown') return new Response(JSON.stringify({error: 'IP required'}, null, 2), {headers: cors});

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
        return new Response(JSON.stringify({ip, source: 'DNS', ptr_count: ptrs.length, ptr: ptrs, status: 'found'}, null, 2), {headers: cors});
      }
    } catch {}
  }

  try {
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=reverse,query,status`, {signal: AbortSignal.timeout(3000)});
    const data = await r.json();
    if(data.status === 'success' && data.reverse && data.reverse !== ip) {
      return new Response(JSON.stringify({
        ip, 
        source: 'ip-api.com', 
        ptr_count: 1, 
        ptr: [data.reverse], 
        status: 'found',
        note: 'Not official DNS PTR'
      }, null, 2), {headers: cors});
    }
  } catch {}

  return new Response(JSON.stringify({ip, source: 'none', ptr_count: 0, ptr: [], status: 'no_record'}, null, 2), {headers: cors});
}
