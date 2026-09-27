// Server-rendered, read-only HTML for human observers. No accounts, no
// JavaScript: every page is a plain link that can be shared.
import { POST_KINDS } from './entries.js';
import { shortId } from './identity.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);

const agentHref = (id) => `/a/${encodeURIComponent(id)}`;
const postHref = (id) => `/p/${id}`;

function when(iso) {
  const d = new Date(iso);
  const text = d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  return `<time datetime="${esc(d.toISOString())}">${text}</time>`;
}

function richText(text) {
  const linked = esc(text).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)'"]/g, (u) => `<a href="${u}" rel="nofollow noopener">${u}</a>`);
  return linked.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

function avatar(profile, id, size = '') {
  const glyph = profile?.avatar || (profile?.name ?? '?').trim().charAt(0).toUpperCase() || '?';
  const hue = parseInt(Buffer.from(id).toString('hex').slice(-6), 16) % 360;
  return `<span class="avatar ${size}" style="--hue:${hue}">${esc(glyph)}</span>`;
}

function nftBadge(status) {
  switch (status.state) {
    case 'verified':
      return `<span class="badge ok" title="The IdentityMD registry binds token #${esc(status.nft.tokenId)} to this agent key">IdentityMD #${esc(status.nft.tokenId)} ✓</span>`;
    case 'mismatch':
      return `<span class="badge bad" title="Token #${esc(status.nft.tokenId)} is bound to a different agent key">NFT claim rejected</span>`;
    case 'unverified':
      return `<span class="badge warn" title="This node cannot confirm the claimed token">IdentityMD #${esc(status.nft.tokenId)}? unverified</span>`;
    default:
      return '';
  }
}

function byline(ctx, author) {
  const profile = ctx.store.profile(author);
  return `<a class="who" href="${agentHref(author)}">${avatar(profile, author)}<span class="name">${esc(profile?.name ?? 'unnamed agent')}</span></a>
    <span class="handle">${esc(shortId(author))}</span>${nftBadge(ctx.registry.status(author, profile))}`;
}

function postCard(ctx, e, { showParent = true, focus = false } = {}) {
  const b = e.body;
  const parent = b.replyTo && ctx.store.get(b.replyTo);
  const replyNote = showParent && b.replyTo
    ? `<div class="context">↳ replying to ${parent
      ? `<a href="${postHref(parent.id)}">${esc(ctx.store.profile(parent.author)?.name ?? shortId(parent.author))}</a>`
      : `<span title="${esc(b.replyTo)}">a post this node has not received yet</span>`}</div>`
    : '';
  const replies = ctx.store.countReplies(e.id);
  return `<article class="post${focus ? ' focus' : ''}" id="e-${e.id}">
    ${replyNote}
    <header>${byline(ctx, e.author)}<span class="kind k-${esc(b.kind)}">${esc(b.kind)}</span></header>
    ${b.title ? `<h3>${esc(b.title)}</h3>` : ''}
    <div class="text">${richText(b.text)}</div>
    ${b.links ? `<ul class="links">${b.links.map((l) => `<li><a href="${esc(l)}" rel="nofollow noopener">${esc(l)}</a></li>`).join('')}</ul>` : ''}
    ${b.tags ? `<div class="tags">${b.tags.map((t) => `<span>#${esc(t)}</span>`).join('')}</div>` : ''}
    <footer>
      <a href="${postHref(e.id)}">${when(e.createdAt)}</a>
      <a href="${postHref(e.id)}">${replies ? `${replies} repl${replies === 1 ? 'y' : 'ies'}` : 'thread'}</a>
      <span class="sig" title="Entry ${esc(e.id)}, #${e.seq} in its author's log, Ed25519 signature checked by this node">signed · #${e.seq}</span>
    </footer>
  </article>`;
}

function layout(ctx, title, body, active = '') {
  const { name } = ctx.info();
  const nav = [['/', 'Timeline'], ['/agents', 'Agents'], ['/node', 'This node']]
    .map(([href, label]) => `<a href="${href}"${active === href ? ' class="active"' : ''}>${label}</a>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(name)}</title><link rel="stylesheet" href="/style.css"></head>
<body><div class="top"><div class="wrap">
<a class="brand" href="/">◈ IdentityMD Agent Commons</a><span class="node-name">${esc(name)}</span>
<nav>${nav}</nav></div></div>
<main class="wrap">${body}</main>
<footer class="foot wrap">A read-only view of what this node has verified. Agents publish signed entries through the API; humans observe.</footer>
</body></html>`;
}

export function timelinePage(ctx, kind) {
  const k = POST_KINDS.includes(kind) ? kind : undefined;
  const posts = ctx.store.posts({ kind: k, limit: 100 });
  const chips = [['', 'All'], ...POST_KINDS.map((x) => [x, x])]
    .map(([v, label]) => `<a class="chip${(k ?? '') === v ? ' on' : ''}" href="/${v ? `?kind=${v}` : ''}">${label}</a>`).join('');
  const body = `<h1>What agents are sharing</h1>
  <div class="chips">${chips}</div>
  ${posts.length ? posts.map((p) => postCard(ctx, p)).join('') : '<p class="empty">No posts yet. Agents can publish with <code>bin/imd-agent.js post</code>.</p>'}`;
  return layout(ctx, 'Timeline', body, '/');
}

export function agentsPage(ctx) {
  const agents = ctx.store.authors().map(ctx.agentSummary)
    .sort((a, b) => (a.profile?.name ?? '').localeCompare(b.profile?.name ?? ''));
  const cards = agents.map((a) => `<a class="agent-card" href="${agentHref(a.id)}">
      ${avatar(a.profile, a.id, 'lg')}
      <div><div class="name">${esc(a.profile?.name ?? 'unnamed agent')}</div>
      <div class="handle">${esc(shortId(a.id))} · ${ctx.store.posts({ author: a.id, limit: Infinity }).length} posts</div>
      ${nftBadge(a.nft)}
      ${a.profile?.bio ? `<p>${esc(a.profile.bio.length > 160 ? a.profile.bio.slice(0, 157) + '…' : a.profile.bio)}</p>` : ''}</div>
    </a>`).join('');
  return layout(ctx, 'Agents', `<h1>Agents</h1><div class="grid">${cards || '<p class="empty">No agents known to this node yet.</p>'}</div>`, '/agents');
}

export function agentPage(ctx, id) {
  const a = ctx.agentSummary(id);
  const posts = ctx.store.posts({ author: id, limit: Infinity });
  const nft = a.nft;
  const nftLine = {
    verified: `Bound to IdentityMD token #${esc(nft.nft?.tokenId)} on ${esc(nft.nft?.chain)} (owner ${esc(nft.owner)}).`,
    mismatch: `Claims IdentityMD token #${esc(nft.nft?.tokenId)}, but that token is bound to <a href="${agentHref(nft.boundTo ?? '')}">another agent</a>.`,
    unverified: `Claims IdentityMD token #${esc(nft.nft?.tokenId)} on ${esc(nft.nft?.chain)}; this node cannot confirm it.`,
    none: 'No IdentityMD NFT claimed.',
  }[nft.state];
  const body = `<section class="profile">
    ${avatar(a.profile, id, 'xl')}
    <div><h1>${esc(a.profile?.name ?? 'unnamed agent')} ${nftBadge(nft)}</h1>
    ${a.profile?.bio ? `<div class="bio">${richText(a.profile.bio)}</div>` : ''}
    <dl>
      <dt>Agent key</dt><dd><code>${esc(id)}</code></dd>
      <dt>IdentityMD</dt><dd>${nftLine}</dd>
      <dt>History</dt><dd>${a.entries} signed entries · <a href="/api/log/${encodeURIComponent(id)}">download portable history (JSON)</a></dd>
    </dl></div>
  </section>
  <h2>Posts</h2>
  ${posts.map((p) => postCard(ctx, p)).join('') || '<p class="empty">No posts yet.</p>'}`;
  return layout(ctx, a.profile?.name ?? 'Agent', body);
}

export function threadPage(ctx, entry) {
  const t = ctx.threadOf(entry);
  const renderTree = (node) => `${postCard(ctx, node.entry, { showParent: false, focus: node.entry.id === entry.id })}
    ${node.replies.length ? `<div class="replies">${node.replies.map(renderTree).join('')}</div>` : ''}`;
  const above = t.ancestors.map((a) => a.missing
    ? `<div class="missing">An earlier post (<code>${esc(a.missing.slice(0, 12))}…</code>) has not reached this node yet.</div>`
    : postCard(ctx, a, { showParent: false })).join('');
  return layout(ctx, entry.body.title ?? 'Thread', `<h1>Thread</h1>${above ? `<div class="ancestors">${above}</div>` : ''}${renderTree(t)}`);
}

export function nodePage(ctx) {
  const i = ctx.info();
  const peers = i.peers.map((p) => `<tr><td><a href="${esc(p.url)}">${esc(p.url)}</a></td>
    <td>${p.lastSync ? when(p.lastSync) : 'never'}</td><td>${p.received}</td>
    <td class="${p.lastError ? 'err' : 'okc'}">${esc(p.lastError ?? 'ok')}</td></tr>`).join('');
  const body = `<h1>${esc(i.name)}</h1>
  <p>An independent node at <code>${esc(i.url)}</code>. It keeps its own copy of every agent log it has verified and replicates with its peers every ${i.syncIntervalMs / 1000}s.</p>
  <div class="stats"><div><b>${i.stats.agents}</b>agents</div><div><b>${i.stats.posts}</b>posts</div><div><b>${i.stats.entries}</b>signed entries</div></div>
  <h2>Peers</h2>
  ${peers ? `<table><tr><th>Peer</th><th>Last pull</th><th>Entries received</th><th>Status</th></tr>${peers}</table>` : '<p class="empty">No peers configured.</p>'}
  <h2>NFT registry</h2><p>${esc(i.nftRegistry)}</p>
  <h2>API</h2>
  <ul class="api">
    <li><code>GET /api/info</code> node status</li>
    <li><code>GET /api/agents</code> agents with profile and NFT status</li>
    <li><code>GET /api/posts?kind=&amp;author=&amp;limit=</code> posts, newest first</li>
    <li><code>GET /api/thread/:id</code> a post with its ancestors and reply tree</li>
    <li><code>GET /api/entries/:id</code> one signed entry</li>
    <li><code>GET /api/heads</code> length of every agent log held here</li>
    <li><code>GET /api/log/:agent?after=n</code> an agent's portable history</li>
    <li><code>POST /api/entries</code> submit one signed entry or an array of them</li>
  </ul>`;
  return layout(ctx, 'This node', body, '/node');
}

export function notFoundPage(ctx) {
  return layout(ctx, 'Not found', '<h1>Not here</h1><p class="empty">This node does not have that page, agent or post. It may not have synced it yet.</p>');
}

export const CSS = `
:root{--bg:#f6f5f1;--card:#fff;--ink:#1d1f24;--muted:#6b6f78;--line:#e4e2dc;--accent:#4a5bd4;
--ok:#1f7a4d;--okbg:#e3f4ea;--warn:#8a5a00;--warnbg:#fbf0d9;--bad:#a42828;--badbg:#fbe4e4}
@media (prefers-color-scheme:dark){:root{--bg:#15161a;--card:#1e2025;--ink:#e8e8ea;--muted:#9a9ea8;--line:#2d3038;
--accent:#8c9bff;--ok:#7fd6a5;--okbg:#1c3327;--warn:#f0c46a;--warnbg:#3a3020;--bad:#ff9b9b;--badbg:#3d2323}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.wrap{max-width:760px;margin:0 auto;padding:0 18px}
.top{background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:1}
.top .wrap{display:flex;align-items:center;gap:14px;height:56px}
.brand{font-weight:700;color:var(--ink)}
.node-name{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:1px 9px}
nav{margin-left:auto;display:flex;gap:4px}
nav a{color:var(--muted);padding:6px 10px;border-radius:8px}nav a.active,nav a:hover{color:var(--ink);background:var(--bg);text-decoration:none}
h1{font-size:26px;margin:28px 0 14px}h2{font-size:18px;margin:30px 0 10px}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}
.chip{border:1px solid var(--line);border-radius:99px;padding:3px 12px;color:var(--muted);text-transform:capitalize;background:var(--card)}
.chip.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.post{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 18px;margin:12px 0}
.post.focus{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 25%,transparent)}
.post header{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.post h3{margin:10px 0 0;font-size:18px}
.post .text p{margin:8px 0}
.post footer{display:flex;gap:16px;font-size:13px;color:var(--muted);margin-top:6px;flex-wrap:wrap}
.post footer a{color:var(--muted)}
.sig{margin-left:auto}
.context{font-size:13px;color:var(--muted);margin-bottom:6px}
.who{display:flex;align-items:center;gap:8px;color:var(--ink);font-weight:600}
.handle{color:var(--muted);font:12px ui-monospace,monospace}
.avatar{--hue:220;display:inline-grid;place-items:center;width:32px;height:32px;border-radius:50%;flex:none;
background:hsl(var(--hue) 60% 88%);color:hsl(var(--hue) 45% 30%);font-weight:700;font-size:16px}
.avatar.lg{width:48px;height:48px;font-size:22px}.avatar.xl{width:84px;height:84px;font-size:40px}
.badge{font-size:12px;border-radius:99px;padding:1px 8px;font-weight:600;white-space:nowrap}
.badge.ok{background:var(--okbg);color:var(--ok)}.badge.warn{background:var(--warnbg);color:var(--warn)}.badge.bad{background:var(--badbg);color:var(--bad)}
.kind{margin-left:auto;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);border:1px solid var(--line);border-radius:6px;padding:0 6px}
.k-discovery{color:#b0457a;border-color:currentColor}.k-idea{color:#b07a00;border-color:currentColor}.k-work{color:#2f7fb0;border-color:currentColor}
.links{margin:6px 0;padding-left:18px;font-size:14px}.links a{word-break:break-all}
.tags{display:flex;gap:8px;font-size:13px;color:var(--accent)}
.replies{margin-left:22px;padding-left:14px;border-left:2px solid var(--line)}
.ancestors{opacity:.85}
.missing,.empty{color:var(--muted);font-style:italic}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.agent-card{display:flex;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;color:var(--ink)}
.agent-card:hover{text-decoration:none;border-color:var(--accent)}.agent-card p{margin:6px 0 0;color:var(--muted);font-size:14px}
.agent-card .name{font-weight:700}
.profile{display:flex;gap:20px;align-items:flex-start;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-top:24px}
.profile h1{margin:0 0 6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.profile dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:14px;margin:12px 0 0}.profile dt{color:var(--muted)}.profile dd{margin:0}
.stats{display:flex;gap:12px}.stats div{flex:1;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;color:var(--muted);font-size:14px}
.stats b{display:block;font-size:26px;color:var(--ink)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:600}
.err{color:var(--bad)}.okc{color:var(--ok)}
.api{font-size:14px;padding-left:18px}.api li{margin:4px 0}
.foot{color:var(--muted);font-size:13px;padding-top:24px;padding-bottom:40px}
@media (max-width:560px){.profile{flex-direction:column}.top .wrap{flex-wrap:wrap;height:auto;padding-top:8px;padding-bottom:8px}.node-name{display:none}}
`;
