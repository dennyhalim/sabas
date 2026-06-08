export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const params = url.searchParams;

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json'
    };

    const pretty = (data, h = cors) => new Response(JSON.stringify(data, null, 2), {headers: h});

    if (request.method === 'OPTIONS') {
      return new Response(null, {headers: cors});
    }

    try {
      if (path === '/api/asn' || path === '/api/asn/') {
        return asn(params.get('ip'), request, pretty);
      }
      if (path === '/api/subdomains' || path === '/api/subdomains/') {
        return subdomains(params.get('domain'), pretty);
      }
      if (path === '/api/dns' || path === '/api/dns/') {
        return dnsProp(params.get('domain'), params.get('type') || 'A', pretty);
      }
      if (path === '/api/ptr' || path === '/api/ptr/') {
        return ptr(params.get('ip'), request, pretty);
      }
      if (path === '/api/rdap' || path === '/api/rdap/') {
        return rdap(params.get('domain'), pretty);
      }
      if (path === '/api/screenshot' || path === '/api/screenshot/') {
        return screenshot(params.get('url'), pretty);
      }
      if (path === '/api/whois' || path === '/api/whois/') {
        return whois(params.get('domain'), pretty);
      }
      if (path === '/api/whois_raw' || path === '/api/whois_raw/') {
        return whoisRaw(params.get('domain'), pretty);
      }

      return pretty({error: 'Endpoint not found. Use /api/asn, /api/subdomains, /api/dns, /api/ptr, /api/rdap, /api/screenshot, /api/whois, /api/whois_raw'});
    } catch (e) {
      return pretty({error: e.message});
    }
  }
}

function getIP(ipParam, request) {
  if(ipParam) return ipParam;
  const cfIP = request.headers.get('CF-Connecting-IP');
  const xff = request.headers.get('X-Forwarded-For');
  return cfIP || xff?.split(',')[0].trim() || 'unknown';
}

async function asn(ipParam, request, pretty) {
  const ip = getIP(ipParam, request);
  if(ip === 'unknown') return pretty({error: 'IP required'});

  try {
    const r = await fetch(`https://ip-api.com/json/${ip}?fields=status,message,query,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,asname`, {signal: AbortSignal.timeout(5000)});
    const data = await r.json();
    if(data.status === 'fail') return pretty({error: data.message});
    return pretty(data);
  } catch(e) {
    return pretty({error: e.message});
  }
}

async function subdomains(domain, pretty) {
  if(!domain) return pretty({error: 'domain required'});
  try {
    const r = await fetch(`https://crt.sh/?q=%.${domain}&output=json`, {signal: AbortSignal.timeout(8000)});
    const data = await r.json();
    const subs = [...new Set(data.map(d => d.name_value).flatMap(n => n.split('\n')).filter(s => s.includes(domain) &&!s.startsWith('*')))];
    return pretty({domain, count: subs.length, subdomains: subs.slice(0, 100)});
  } catch(e) {
    return pretty({error: e.message});
  }
}

async function dnsProp(domain, type, pretty) {
  if(!domain) return pretty({error: 'domain required'});
  type = type.toUpperCase();

  const resolvers = [
    {name: 'Google', url: 'https://dns.google/resolve'},
    {name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query'}
  ];

  const results = {};
  for(let r of resolvers) {
    try {
      const res = await fetch(`${r.url}?name=${encodeURIComponent(domain)}&type=${encodeURIComponent(type)}`, {
        headers: {'Accept': 'application/dns-json'},
        signal: AbortSignal.timeout(5000)
      });

      if(!res.ok) {
        results[r.name] = [`HTTP ${res.status}`];
        continue;
      }

      const json = await res.json();
      if(json.Status!== 0) {
        results[r.name] = [`DNS Status ${json.Status}`];
        continue;
      }

      const answers = json.Answer?.map(a => a.data.replace(/\.$/, '')) || [];
      results[r.name] = answers.length? answers : ['No records'];

    } catch(e) {
      results[r.name] = ['Error: ' + e.message];
    }
  }

  return pretty({domain, type, results});
}

async function ptr(ipParam, request, pretty) {
  const ip = getIP(ipParam, request);
  if(ip === 'unknown') return pretty({error: 'IP required'});

  if(ip.includes(':')) return pretty({ip, ptr: [], note: 'IPv6 PTR not supported yet'});

  const reversed = ip.split('.').reverse().join('.') + '.in-addr.arpa';
  try {
    const r = await fetch(`https://dns.google/resolve?name=${reversed}&type=PTR`, {
      headers: {'Accept': 'application/dns-json'},
      signal: AbortSignal.timeout(4000)
    });

    if(!r.ok) return pretty({ip, ptr: [], query: reversed, error: `HTTP ${r.status}`});

    const json = await r.json();

    if(json.Status === 3 || json.Status === 2) {
      return pretty({ip, ptr: [], query: reversed, status: 'no_record', dns_status: json.Status});
    }

    const ptrs = json.Answer?.filter(a => a.type === 12).map(a => a.data.replace(/\.$/, '')) || [];

    return pretty({
      ip,
      query: reversed,
      ptr_count: ptrs.length,
      ptr: ptrs,
      status: ptrs.length? 'found' : 'no_record',
      dns_status: json.Status
    });

  } catch(e) {
    return pretty({ip, ptr: [], query: reversed, error: 'Fetch error: ' + e.message});
  }
}

async function rdap(domain, pretty) {
  if(!domain) return pretty({error: 'domain required'});
  try {
    const r = await fetch(`https://rdap.org/domain/${domain}`, {signal: AbortSignal.timeout(5000)});
    if(!r.ok) return pretty({error: `RDAP HTTP ${r.status}`});
    const data = await r.json();
    return pretty({
      domain,
      events: data.events?.map(e => ({event: e.eventAction, date: e.eventDate})),
      entities: data.entities?.map(e => e.vcardArray?.[1]?.find(v => v[0] === 'fn')?.[3]),
      nameservers: data.nameservers?.map(n => n.ldhName)
    });
  } catch(e) {
    return pretty({error: e.message});
  }
}

async function screenshot(urlParam, pretty) {
  if(!urlParam) return pretty({error: 'url required'});
  let url = urlParam;
  if(!url.startsWith('http')) url = 'https://' + url;
  const shotUrl = `https://image.thum.io/get/width/1200/crop/2000/${encodeURIComponent(url)}`;
  return pretty({url, screenshot_url: shotUrl, note: 'Open screenshot_url in browser'});
}

async function whois(domain, pretty) {
  if(!domain) return pretty({error: 'domain required'});
  try {
    const r = await fetch(`https://rdap.org/domain/${domain}`, {signal: AbortSignal.timeout(5000)});
    if(!r.ok) return pretty({error: `RDAP HTTP ${r.status}`});
    const data = await r.json();
    const getEvent = (type) => data.events?.find(e => e.eventAction === type)?.eventDate;
    return pretty({
      domain,
      registrar: data.entities?.find(e => e.roles?.includes('registrar'))?.vcardArray?.[1]?.find(v => v[0] === 'fn')?.[3],
      created: getEvent('registration'),
      expires: getEvent('expiration'),
      updated: getEvent('last changed'),
      status: data.status
    });
  } catch(e) {
    return pretty({error: e.message});
  }
}

async function whoisRaw(domain, pretty) {
  if(!domain) return pretty({error: 'domain required'});
  try {
    const r = await fetch(`https://rdap.org/domain/${domain}`, {signal: AbortSignal.timeout(5000)});
    if(!r.ok) return pretty({error: `RDAP HTTP ${r.status}`});
    const data = await r.json();
    return pretty(data);
  } catch(e) {
    return pretty({error: e.message});
  }
}
