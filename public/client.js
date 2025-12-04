document.getElementById('year').textContent = new Date().getFullYear();
async function loadArticles(){
    try{
        const res = await fetch('/data/articles.json', {cache: 'no-store'});
        if(!res.ok) throw new Error('articles.json não encontrado');
        const data = await res.json();
        renderArticles(data.articles || []);
    }catch(err){
        console.warn(err);
        // fallback: mostrar mensagem
        document.getElementById('articles').innerHTML = '<div class="card">Nenhum artigo disponível — assegure que o bot gerou /data/articles.json</div>';
    }
}

function renderArticles(list){
    const container = document.getElementById('articles');
    container.innerHTML = '';
    if(list.length===0){container.innerHTML = '<div class="card">Sem artigos ainda.</div>';return}

    list.forEach(article=>{
        const el = document.createElement('div');
        el.className = 'card article';
        el.innerHTML = `
          <h2><a href="${article.url}" target="_blank" rel="noopener">${escapeHtml(article.title)}</a></h2>
          <div class="meta">${escapeHtml(article.source)} • ${new Date(article.published).toLocaleString()}</div>
          <p class="excerpt">${escapeHtml(article.excerpt)}</p>
        `;
        container.appendChild(el);
    });
}

function escapeHtml(str){ if(!str) return ''; return str.replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// Busca simples
document.getElementById('search').addEventListener('input', async (e)=>{
    const q = e.target.value.toLowerCase();
    const res = await fetch('/data/articles.json', {cache:'no-store'}).then(r=>r.json()).catch(()=>({articles:[]}));
    const filtered = (res.articles||[]).filter(a => (a.title + ' ' + a.excerpt + ' ' + a.source).toLowerCase().includes(q));
    renderArticles(filtered);
});

loadArticles();