const MAX_POST = 10;
const CACHE_TTL = 300;

export async function onRequest(context) {

    const url = new URL(context.request.url);
    const format = url.searchParams.get("format") || "html";

    const opmlURL = new URL("/feeds.opml", url).toString();

    let opml = await fetch(opmlURL).then(r => r.text());

    let feeds = parseOPML(opml);


    let posts = [];

    for (const feed of feeds) {

        try {

            const xml = await cachedFetch(
                context,
                feed.xmlUrl
            );

            const items = parseFeed(
                xml,
                feed.title
            );

            posts.push(...items);

        } catch(e) {
            console.log("feed error", feed.xmlUrl);
        }
    }


    posts.sort((a,b)=>
        new Date(b.date)-new Date(a.date)
    );


    if(format==="rss"){
        return rssOutput(posts);
    }


    if(format==="embed"){
        return embedOutput(posts);
    }


    return htmlOutput(posts);
}



function parseOPML(xml){

    let out=[];

    let re=/<outline[^>]+xmlUrl="([^"]+)"[^>]*text="([^"]*)"/gi;

    let m;

    while((m=re.exec(xml))){
        out.push({
            title:m[2],
            xmlUrl:m[1]
        });
    }

    return out;
}



async function cachedFetch(context,url){

    const cache =
        caches.default;

    const key =
        new Request(url);


    let res =
        await cache.match(key);


    if(res)
        return res.text();


    res =
        await fetch(url,{
            headers:{
                "User-Agent":"Cloudflare RSS Reader"
            }
        });


    context.waitUntil(
        cache.put(
            key,
            res.clone()
        )
    );


    return res.text();
}




function parseFeed(xml,source){

    let items=[];


    let blocks =
        xml.match(/<item[\s\S]*?<\/item>/gi);


    if(!blocks){

        blocks =
        xml.match(/<entry[\s\S]*?<\/entry>/gi);

    }


    if(!blocks)
        return [];


    for(let b of blocks.slice(0,MAX_POST)){


        let title =
            tag(b,"title");


        let link =
            tag(b,"link") ||
            linkHref(b);


        let date =
            tag(b,"pubDate") ||
            tag(b,"updated") ||
            tag(b,"published") ||
            new Date().toISOString();


        items.push({

            title:clean(title),
            link:clean(link),
            date:date,
            source:source

        });

    }


    return items;
}



function tag(x,n){

    let r =
    new RegExp(
        `<${n}[^>]*>([\\s\\S]*?)<\\/${n}>`,
        "i"
    );

    let m=x.match(r);

    return m ? m[1] : "";

}



function linkHref(x){

    let m =
    x.match(/<link[^>]+href="([^"]+)"/i);

    return m ? m[1] : "";

}



function clean(x){

    return (x||"")
    .replace(/<!\[CDATA\[/g,"")
    .replace(/\]\]>/g,"")
    .replace(/<[^>]+>/g,"")
    .trim();

}




function htmlOutput(posts){

let html=`

<!doctype html>
<html>
<head>
<meta charset=utf-8>
<title>RSS Reader</title>

<style>
body{
font-family:Arial;
max-width:800px;
margin:auto;
}

article{
padding:12px;
border-bottom:1px solid #ddd;
}

small{
color:#777;
}
</style>

</head>

<body>

<h1>RSS Reader</h1>

`;

for(let p of posts){

html+=`

<article>

<h3>
<a href="${p.link}">
${escapeHTML(p.title)}
</a>
</h3>

<small>
${p.source}
${p.date}
</small>

</article>

`;

}


html+=`

</body>
</html>

`;


return new Response(html,{
headers:{
"content-type":"text/html;charset=utf-8"
}
});

}





function rssOutput(posts){

let body="";

for(let p of posts){

body+=`

<item>
<title>${escapeHTML(p.title)}</title>
<link>${p.link}</link>
<pubDate>${p.date}</pubDate>
</item>

`;

}


return new Response(`

<?xml version="1.0"?>

<rss version="2.0">
<channel>

<title>Combined RSS</title>

<link></link>

${body}

</channel>
</rss>

`,{
headers:{
"content-type":"application/rss+xml"
}
});

}





function embedOutput(posts){

return new Response(`

document.write(\`
${htmlOutput(posts)
.replace(/`/g,"\\`")}
\`
);

`,{
headers:{
"content-type":"application/javascript"
}
});

}





function escapeHTML(s){

return (s||"")
.replace(/&/g,"&amp;")
.replace(/</g,"&lt;")
.replace(/>/g,"&gt;")
.replace(/"/g,"&quot;");

}
