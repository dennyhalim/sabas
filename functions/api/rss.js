function parseOPML(xml){

    let out=[];

    let blocks =
        xml.match(/<outline\b[^>]*\/?>/gi) || [];

    for (let b of blocks){

        let xmlUrl =
            attr(b,"xmlUrl");

        if(!xmlUrl)
            continue;


        out.push({

            title:
                attr(b,"title") ||
                attr(b,"text") ||
                xmlUrl,

            xmlUrl: xmlUrl

        });

    }

    return out;
}


function attr(tag,name){

    let r =
    new RegExp(
        name+'\\s*=\\s*["\']([^"\']+)["\']',
        "i"
    );

    let m = tag.match(r);

    return m ? m[1] : "";

}
