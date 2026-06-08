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

  const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), {status, headers: cors});

  try {
    switch(route) {
      case 'ping': return await ping(params.get('host'), json);
      case 'port': return await portCheck(params.get('host'), params.get('port'), json);
      case 'dns': return await dnsProp(params.get('domain'), params.get('type') || 'A', json);
      case 'whois': return await whois(params.get('domain'), json);
      case 'mail': return await mailHealth(params.get('domain'), json);
      case 'web': return await webHealth(params.get('url'), json);
      case 'subdomains': return await subdomains(params.get('domain'), json);
      case 'geo': return await geo(context, params.get('ip'), json);
      case 'asn': return await asn(params.get('ip'), context, json);
      case 'ptr': return await ptr(params.get('ip'), context, json);
      case 'blacklist': return await blacklist(params.get('ip'), context, json);
      case 'bgp': return await bgp(params.get('ip'), context, json);
      case 'trace': return await trace(params.get('host'), json);
      default: return json({error: 'Route not found. Use: ping, port, dns, whois, mail, web, subdomains, geo, asn, ptr, blacklist, bgp, trace'}, 404);
    }
  } catch(e) {
    return json({error: e.message}, 500);
  }
}

function getIP(paramIP, context) {
  return paramIP || context.request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function ping(host, json) {
  if(!host) return json({error: 'host required'});
  const start = Date.now();
  try {
    await fetch(`https://${host}`, {method: 'HEAD', signal: AbortSignal.timeout(3000)});
    return json({host, latency_ms: Date.now() - start, method: 'HTTPS HEAD'});
  } catch {
    try {
      await fetch(`http://${host}`, {method: 'HEAD', signal: AbortSignal.timeout(3000)});
      return json({host, latency_ms: Date.now() - start, method: 'HTTP HEAD'});
    } catch(e) {
      return json({host, error: 'Unreachable', latency_ms: Date.now() - start});
    }
  }
}

async function portCheck(host, port, json) {
  if(!host ||!port) return json({error: 'host and port required'});
  const start = Date.now();
  try {
    await fetch(`${port == 443? 'https' : 'http'}://${host}:${port}`, {method: 'HEAD', signal: AbortSignal.timeout(2000)});
    return json({host, port: +port, status: 'open', latency_ms: Date.now() - start});
  } catch {
    return json({host, port: +port, status: 'closed/filtered'});
  }
}

async function dnsProp(domain, type, json) {
  if(!domain) return json({error: 'domain required'});

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
  return json({domain, type, results});
}

//... rest of your functions same pattern, just change last line from Response.json to json()
async function whois(domain, json) {
  if(!domain) return json({error: 'domain required'});
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
    return json({
      domain,
      registrar,
      created,
      expires,
      nameservers,
      soa: soaRecord.length? {mname: soaRecord[0], rname: soaRecord[1], serial: soaRecord[2]} : null,
      note: 'RDAP blocked by provider. Using DNS + whoisjson fallback.'
    });
  } catch(e) {
    return json({error: 'Lookup failed: ' + e.message});
  }
}
