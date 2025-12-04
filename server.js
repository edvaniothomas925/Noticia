const RSSParser = require('rss-parser');
const parser = new RSSParser({ timeout: 15000 });
const fs = require('fs-extra');
const path = require('path');
const sanitizeHtml = require('sanitize-html');
const cron = require('node-cron');
const fetch = require('node-fetch');
const sharp = require('sharp');
const crypto = require('crypto');
const slugify = require('slugify');

const DATA_PATH = path.join(__dirname, 'data');
const IMG_PATH = path.join(DATA_PATH, 'images');
const OUT_FILE = path.join(DATA_PATH, 'articles.json');
const PUBLIC_PATH = path.join(__dirname, 'public');
const ARTICLES_DIR = path.join(PUBLIC_PATH, 'articles');
const SITEMAP_FILE = path.join(PUBLIC_PATH, 'sitemap.xml');

const FEEDS = [
    // seus feeds autorizados
    'https://feeds.bbci.co.uk/news/world/rss.xml',
    'https://rss.nytimes.com/services/xml/rss/nyt/World.xml'
];

const FALLBACK_IMAGE = path.join(PUBLIC_PATH, 'assets', 'fallback.jpg'); // coloque uma fallback.jpg em public/assets/

// util: gera slug único a partir do título + hash curto
function makeSlug(title, id){
    const base = slugify(title || 'noticia', { lower: true, strict: true, remove: /[*+~.()'"!:@]/g }).slice(0,80);
    const hash = crypto.createHash('md5').update(String(id || title)).digest('hex').slice(0,8);
    return `${base}-${hash}`;
}

// util: fingerprint para deduplication (normaliza título + url)
function fingerprint(item){
    const normalized = (item.title || '') + '|' + (item.link || '') + '|' + (item.pubDate || '');
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

async function downloadImage(url, filenameBase){
    try{
        const res = await fetch(url, { timeout: 15000 });
        if(!res.ok) throw new Error('HTTP ' + res.status);
        const buffer = await res.buffer();

        const originalJpg = filenameBase + '.jpg';
        const webpName = filenameBase + '.webp';
        const thumbJpg = 'thumb_' + filenameBase + '.jpg';
        const thumbWebp = 'thumb_' + filenameBase + '.webp';

        // salvar original (como jpg) e gerar webp + thumbnail webp
        await fs.writeFile(path.join(IMG_PATH, originalJpg), buffer);

        // gerar webp (lossy) para melhor compressão
        await sharp(buffer).webp({ quality: 75 }).toFile(path.join(IMG_PATH, webpName));

        // gerar thumbnail 400px width e converter para webp
        await sharp(buffer).resize({ width: 400 }).webp({ quality: 70 }).toFile(path.join(IMG_PATH, thumbWebp));

        return {
            image: '/data/images/' + webpName,
            thumb: '/data/images/' + thumbWebp,
            original: '/data/images/' + originalJpg
        };
    }catch(err){
        console.warn('downloadImage fail', url, err.message);
        return null;
    }
}

async function ensureFallbackExists(){
    // se não existir fallback no IMG_PATH, copie do PUBLIC_PATH/assets
    try{
        await fs.ensureDir(IMG_PATH);
        const fallbackTarget = path.join(IMG_PATH, 'fallback.jpg');
        if(!(await fs.pathExists(fallbackTarget))){
            if(await fs.pathExists(FALLBACK_IMAGE)){
                await fs.copyFile(FALLBACK_IMAGE, fallbackTarget);
                // criar webp e thumb também
                const buff = await fs.readFile(fallbackTarget);
                await sharp(buff).webp({ quality: 75 }).toFile(path.join(IMG_PATH, 'fallback.webp'));
                await sharp(buff).resize({ width:400 }).webp({ quality:70 }).toFile(path.join(IMG_PATH, 'thumb_fallback.webp'));
            }else{
                console.warn('Nenhuma imagem fallback encontrada em', FALLBACK_IMAGE);
            }
        }
    }catch(e){console.warn('ensureFallback', e.message)}
}

async function extractImageFromItem(item){
    if(item.enclosure && item.enclosure.url) return item.enclosure.url;
    const content = item['content:encoded'] || item.content || item.summary || '';
    const match = content.match(/<img[^>]+src=["']([^"']+)["']/i);
    if(match) return match[1];
    // alguns feeds têm media:content
    if(item['media:content'] && item['media:content']['$'] && item['media:content']['$'].url) return item['media:content']['$'].url;
    return null;
}

async function generateArticleHtml(article){
    // gera página HTML simples com meta tags SEO + OpenGraph
    const slug = article.slug;
    const filePath = path.join(ARTICLES_DIR, slug + '.html');
    const publishedDate = new Date(article.published).toISOString();
    const imageUrl = article.image || '/data/images/fallback.webp';

    const html = `<!doctype html>
<html lang="pt-PT">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(article.title)}</title>
<meta name="description" content="${escapeHtml(article.excerpt || '').slice(0,150)}" />
<link rel="canonical" href="${article.url}" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${escapeHtml(article.title)}" />
<meta property="og:description" content="${escapeHtml(article.excerpt || '')}" />
<meta property="og:image" content="${imageUrl}" />
<meta property="article:published_time" content="${publishedDate}" />
</head>
<body>
<article>
  <h1>${escapeHtml(article.title)}</h1>
  <p><em>${escapeHtml(article.source)} — ${new Date(article.published).toLocaleString()}</em></p>
  <img src="${article.image || '/data/images/thumb_fallback.webp'}" alt="${escapeHtml(article.title)}" style="max-width:100%;height:auto"/>
  <p>${article.excerpt}</p>
  <p><a href="${article.url}" target="_blank" rel="noopener">Leia original</a></p>
</article>
</body>
</html>`;

    await fs.ensureDir(ARTICLES_DIR);
    await fs.writeFile(filePath, html, 'utf8');
}

function escapeHtml(str){ if(!str) return ''; return String(str).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function writeSitemap(articles){
    const urls = articles.map(a => `  <url>
    <loc>${a.siteUrl || ('/articles/' + a.slug + '.html')}</loc>
    <lastmod>${new Date(a.published).toISOString()}</lastmod>
  </url>`).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
    await fs.writeFile(SITEMAP_FILE, xml, 'utf8');
}

async function fetchFeeds(){
    await fs.ensureDir(DATA_PATH);
    await fs.ensureDir(IMG_PATH);
    await fs.ensureDir(PUBLIC_PATH);
    await ensureFallbackExists();

    let articles = [];
    const seenFingerprints = new Set();

    // se já existe articles.json, carregue fingerprints para evitar reprocessar
    if(await fs.pathExists(OUT_FILE)){
        try{
            const old = await fs.readJson(OUT_FILE);
            (old.articles||[]).forEach(a => seenFingerprints.add(a.fingerprint));
        }catch(e){console.warn('err read old articles', e.message)}
    }

    for(const feedUrl of FEEDS){
        try{
            const feed = await parser.parseURL(feedUrl);
            const source = feed.title || feedUrl;

            for(const item of feed.items.slice(0,20)){
                const fp = fingerprint(item);
                if(seenFingerprints.has(fp)) continue; // pular duplicados já processados

                const clean = sanitizeHtml(item.contentSnippet || item.content || '', { allowedTags: [], allowedAttributes: {} });

                // imagem
                let imgData = null;
                const imgUrl = await extractImageFromItem(item);
                if(imgUrl){
                    const filenameBase = Date.now() + '_' + Math.random().toString(36).slice(2,9);
                    imgData = await downloadImage(imgUrl, filenameBase);
                }

                // se download falhar, use fallback
                const image = (imgData && imgData.image) ? imgData.image : '/data/images/fallback.webp';
                const thumb = (imgData && imgData.thumb) ? imgData.thumb : '/data/images/thumb_fallback.webp';

                const id = item.guid || item.link || crypto.randomBytes(8).toString('hex');
                const title = item.title || 'Sem título';
                const slug = makeSlug(title, id);

                const article = {
                    id,
                    fingerprint: fp,
                    slug,
                    title,
                    url: item.link || '#',
                    source,
                    published: item.isoDate || item.pubDate || new Date().toISOString(),
                    excerpt: clean.slice(0,300),
                    image,
                    thumb,
                    siteUrl: `/articles/${slug}.html`
                };

                // adicionar e marcar seen
                articles.push(article);
                seenFingerprints.add(fp);

                // gerar página HTML por artigo
                try{ await generateArticleHtml(article); }catch(e){ console.warn('gen html', e.message)}
            }
        }catch(err){
            console.warn('erro feed', feedUrl, err.message);
        }
    }

    // combinar com antigos (mantendo newest first e limitando a 500)
    let merged = [];
    if(await fs.pathExists(OUT_FILE)){
        try{ const old = await fs.readJson(OUT_FILE); merged = old.articles || []; }catch(e){ merged = []; }
    }

    merged = articles.concat(merged).filter((v,i,a)=> i < 1000); // limite
    // ordenar
    merged.sort((a,b)=> new Date(b.published) - new Date(a.published));

    await fs.writeJson(OUT_FILE, { generated: new Date().toISOString(), articles: merged }, { spaces:2 });
    console.log('Generated', OUT_FILE, merged.length, 'articles');

    // sitemap
    try{ await writeSitemap(merged.slice(0,500)); }catch(e){console.warn('sitemap', e.message)}
}

// schedule every 15 minutes
cron.schedule('*/15 * * * *', () => fetchFeeds());
fetchFeeds();

// small static server
const express = require('express');
const app = express();
app.use(express.static(PUBLIC_PATH));
app.use('/data', express.static(DATA_PATH));
app.get('/data/articles.json', (req,res)=> res.sendFile(OUT_FILE));
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('Server listening on', PORT));