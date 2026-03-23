const BRAND = {
  name: 'Superb Wear Clothing',
  founder: 'Randy',
  founded: 2017,
  location: 'Chicago, Illinois',
  website: 'https://superbwearclothing.com',
  instagram: '@superbwear_clothing',
  facebook: 'Superb Wear Clothing',
  tiktok: '@superbwear'
};

const STATE_KEY = 'alex:state';
const DEFAULT_FROM = 'hello@superbwearclothing.com';

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/') {
        return new Response(renderApp(), {
          headers: { 'content-type': 'text/html; charset=utf-8' }
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/upload') {
        return await handleUpload(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/chat') {
        return await handleChat(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/reset') {
        return await handleReset(env);
      }
      return json({ ok: false, error: 'Route not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: 'Operator console encountered an unexpected issue.' }, 500);
    }
  }
};

async function handleUpload(request, env) {
  const state = await getState(env);
  const diagnostics = [];
  if (!env.BUCKET) diagnostics.push('BUCKET binding is not configured.');
  if (!env.ALEX_KV) diagnostics.push('ALEX_KV binding is not configured.');

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: 'Upload payload must be multipart/form-data.', diagnostics });
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return json({ ok: false, error: 'No file provided.', diagnostics });
  }

  const now = new Date().toISOString();
  const key = `uploads/${Date.now()}-${sanitizeName(file.name || 'asset')}`;

  if (!env.BUCKET) {
    const metadata = {
      fileName: file.name,
      fileType: file.type || 'application/octet-stream',
      fileSize: file.size,
      width: null,
      height: null,
      bucketKey: key,
      isImage: (file.type || '').startsWith('image/'),
      uploadedAt: now,
      unavailableStorage: true
    };
    state.lastUpload = metadata;
    pushActivity(state, 'upload', { fileName: metadata.fileName, stored: false, reason: 'missing-bucket' });
    await saveState(env, state);
    return json({ ok: true, message: 'Upload metadata captured, but storage is not connected.', lastUpload: metadata, diagnostics });
  }

  const ab = await file.arrayBuffer();
  const imageMeta = await extractImageMetadata(file, ab);

  await env.BUCKET.put(key, ab, {
    httpMetadata: { contentType: file.type || 'application/octet-stream' }
  });

  const metadata = {
    fileName: file.name,
    fileType: file.type || 'application/octet-stream',
    fileSize: file.size,
    width: imageMeta.width,
    height: imageMeta.height,
    bucketKey: key,
    isImage: imageMeta.isImage,
    uploadedAt: now
  };

  state.lastUpload = metadata;
  pushActivity(state, 'upload', { fileName: metadata.fileName, bucketKey: key });
  await saveState(env, state);

  return json({ ok: true, message: 'Upload stored successfully.', lastUpload: metadata, diagnostics });
}

async function handleChat(request, env) {
  const state = await getState(env);
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body.' }, 400);
  }

  const commandRaw = String(body.message || '').trim();
  if (!commandRaw) return json({ ok: false, error: 'Message is required.' }, 400);

  const lower = commandRaw.toLowerCase();
  const diagnostics = collectDiagnostics(env);

  if (lower === 'show dashboard' || lower === 'dashboard') {
    return json({ ok: true, message: 'Operator dashboard loaded.', dashboard: buildDashboard(state, env), diagnostics });
  }
  if (lower.includes('what did i upload')) {
    return json({ ok: true, message: state.lastUpload ? `Last upload: ${state.lastUpload.fileName}` : 'No uploads yet.', lastUpload: state.lastUpload || null, diagnostics });
  }
  if (lower.includes('what was the last email') || lower.includes('show last email')) {
    return json({ ok: true, message: state.lastEmailDraft ? 'Last email draft retrieved.' : 'No email draft has been created yet.', lastEmailDraft: state.lastEmailDraft || null, lastEmailStatus: state.lastEmailStatus || null, diagnostics });
  }
  if (lower.includes('did you actually post that')) {
    return json({ ok: true, message: state.lastFacebookPost ? 'Latest Facebook receipt available.' : 'No Facebook publish receipt found.', lastFacebookPost: state.lastFacebookPost || null, diagnostics });
  }

  if (isTaskAdd(lower)) {
    const title = extractTaskTitle(commandRaw);
    if (!title) return json({ ok: false, error: 'Task title is required.' });
    const item = { id: crypto.randomUUID(), title, done: false, createdAt: new Date().toISOString() };
    state.tasks.push(item);
    pushActivity(state, 'task-add', { id: item.id, title: item.title });
    await saveState(env, state);
    return json({ ok: true, message: `Task added: ${title}`, tasks: state.tasks, diagnostics });
  }
  if (lower.startsWith('list tasks') || lower === 'tasks') {
    return json({ ok: true, message: state.tasks.length ? 'Task list ready.' : 'No tasks yet.', tasks: state.tasks, diagnostics });
  }
  if (lower.startsWith('mark done')) {
    const taskRef = commandRaw.replace(/mark done/i, '').trim();
    const task = findTask(state.tasks, taskRef);
    if (!task) return json({ ok: false, error: 'Task not found.' });
    task.done = true;
    task.doneAt = new Date().toISOString();
    pushActivity(state, 'task-done', { id: task.id, title: task.title });
    await saveState(env, state);
    return json({ ok: true, message: `Marked done: ${task.title}`, tasks: state.tasks, diagnostics });
  }

  if (isSearchCommand(lower)) {
    const q = stripLead(commandRaw, ['search', 'research', 'deep search']);
    if (!q) return json({ ok: false, error: 'Search query is required.' });
    const depth = lower.startsWith('deep search') ? 'advanced' : 'standard';
    const searchRes = await doSerperSearch(q, env, depth);
    if (!searchRes.ok) return json({ ok: false, error: searchRes.error, diagnostics: [...diagnostics, ...searchRes.diagnostics] });
    state.lastSearch = searchRes.payload;
    pushActivity(state, 'search', { query: q });
    await saveState(env, state);
    return json({ ok: true, message: `Search complete for: ${q}`, search: searchRes.payload, diagnostics });
  }

  if (lower.includes('summarize last search')) {
    if (!state.lastSearch) return json({ ok: false, error: 'No prior search to summarize.' });
    const summary = await summarizeSearch(state.lastSearch, env);
    pushActivity(state, 'search-summary', { query: state.lastSearch.query });
    await saveState(env, state);
    return json({ ok: true, message: summary, lastSearch: state.lastSearch, diagnostics });
  }

  if (isMarketingCommand(lower)) {
    const m = await buildMarketingPackage(commandRaw, env);
    if (!m.ok) return json({ ok: false, error: m.error, diagnostics: [...diagnostics, ...m.diagnostics] });
    state.lastMarketingPackage = m.package;
    pushActivity(state, 'campaign', { type: m.package.type });
    await saveState(env, state);
    return json({ ok: true, message: 'Marketing package generated.', marketing: m.package, diagnostics });
  }

  if (isEmailCommand(lower)) {
    const res = await handleEmailCommand(commandRaw, lower, env, state);
    await saveState(env, state);
    return json({ ...res, diagnostics: [...(res.diagnostics || []), ...diagnostics] }, res.ok ? 200 : 400);
  }

  if (isFacebookPublishCommand(lower)) {
    const res = await handleFacebookPublish(commandRaw, env, state);
    await saveState(env, state);
    return json({ ...res, diagnostics: [...(res.diagnostics || []), ...diagnostics] }, res.ok ? 200 : 400);
  }

  if (lower.includes('verify last facebook post') || lower.includes('show facebook receipt')) {
    const verify = await verifyFacebookPost(env, state);
    await saveState(env, state);
    return json({ ...verify, diagnostics: [...(verify.diagnostics || []), ...diagnostics] }, verify.ok ? 200 : 400);
  }

  if (lower.includes('prepare instagram draft') || lower.includes('instagram draft')) {
    const draft = await createInstagramDraft(commandRaw, env);
    if (!draft.ok) return json({ ok: false, error: draft.error, diagnostics: [...diagnostics, ...draft.diagnostics] });
    state.instagramDraft = draft.draft;
    pushActivity(state, 'instagram-draft', { generatedAt: draft.draft.generatedAt });
    await saveState(env, state);
    return json({ ok: true, message: 'Instagram draft prepared.', instagramDraft: draft.draft, diagnostics });
  }

  if (lower.includes('check instagram configuration') || lower.includes('instagram readiness')) {
    const readiness = instagramReadiness(env);
    return json({ ok: true, message: readiness.ready ? 'Instagram infrastructure is ready.' : 'Instagram infrastructure needs configuration.', instagram: readiness, diagnostics });
  }

  if (isImageCommand(lower)) {
    const res = await runImageWorkflow(commandRaw, lower, env, state);
    await saveState(env, state);
    return json({ ...res, diagnostics: [...(res.diagnostics || []), ...diagnostics] }, res.ok ? 200 : 400);
  }

  const fallback = await operatorResponse(commandRaw, env, state);
  pushActivity(state, 'assistant', { prompt: commandRaw.slice(0, 80) });
  await saveState(env, state);
  return json({ ok: true, message: fallback, dashboard: buildDashboard(state, env), diagnostics });
}

async function handleReset(env) {
  if (!env.ALEX_KV) {
    return json({ ok: true, message: 'State reset skipped because KV is not configured.', diagnostics: ['ALEX_KV binding is not configured.'] });
  }
  await env.ALEX_KV.delete(STATE_KEY);
  return json({ ok: true, message: 'Session memory reset complete.' });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
}

async function extractImageMetadata(file, arrayBuffer) {
  const isImage = (file.type || '').startsWith('image/');
  if (!isImage) return { isImage, width: null, height: null };
  try {
    const decoder = new ImageDecoder({ data: arrayBuffer, type: file.type || 'image/png' });
    const track = decoder.tracks.selectedTrack;
    return { isImage: true, width: track.codedWidth || null, height: track.codedHeight || null };
  } catch {
    return { isImage: true, width: null, height: null };
  }
}

async function getState(env) {
  const base = {
    lastUpload: null,
    lastSearch: null,
    lastEmailDraft: null,
    lastEmailStatus: null,
    lastFacebookPost: null,
    lastMarketingPackage: null,
    lastGeneratedDesign: null,
    instagramDraft: null,
    tasks: [],
    preferences: { theme: 'dark', accent: 'red' },
    activity: []
  };
  if (!env.ALEX_KV) return base;
  const raw = await env.ALEX_KV.get(STATE_KEY);
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw);
    return { ...base, ...parsed, tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] };
  } catch {
    return base;
  }
}

async function saveState(env, state) {
  if (!env.ALEX_KV) return;
  await env.ALEX_KV.put(STATE_KEY, JSON.stringify(state));
}

function pushActivity(state, type, data = {}) {
  const event = { type, data, at: new Date().toISOString() };
  state.activity.unshift(event);
  if (state.activity.length > 50) state.activity = state.activity.slice(0, 50);
}

function collectDiagnostics(env) {
  const d = [];
  if (!env.AI) d.push('AI binding is not configured.');
  if (!env.BUCKET) d.push('R2 bucket binding is not configured.');
  if (!env.ALEX_KV) d.push('KV namespace binding is not configured.');
  if (!env.SERPER_API_KEY) d.push('SERPER_API_KEY is missing.');
  if (!env.RESEND_API_KEY) d.push('RESEND_API_KEY is missing.');
  if (!env.FB_PAGE_ACCESS_TOKEN || !env.FB_PAGE_ID) d.push('Facebook publishing bindings are incomplete.');
  if (!env.IG_ACCESS_TOKEN || !env.IG_ACCOUNT_ID) d.push('Instagram bindings are incomplete.');
  return d;
}

function buildDashboard(state, env) {
  return {
    brand: BRAND,
    connectedSystems: {
      ai: !!env.AI,
      storage: !!env.BUCKET,
      memory: !!env.ALEX_KV,
      webSearch: !!env.SERPER_API_KEY,
      email: !!env.RESEND_API_KEY,
      facebook: !!env.FB_PAGE_ACCESS_TOKEN && !!env.FB_PAGE_ID,
      instagram: !!env.IG_ACCESS_TOKEN && !!env.IG_ACCOUNT_ID
    },
    lastActivity: state.activity[0] || null,
    facebookConnected: !!env.FB_PAGE_ACCESS_TOKEN && !!env.FB_PAGE_ID,
    instagramReadiness: instagramReadiness(env),
    activity: {
      lastUpload: state.lastUpload,
      lastSearch: state.lastSearch,
      lastEmail: state.lastEmailStatus,
      lastFacebookPost: state.lastFacebookPost,
      lastGeneratedDesign: state.lastGeneratedDesign,
      lastCampaign: state.lastMarketingPackage
    },
    tasks: state.tasks
  };
}

function isTaskAdd(lower) {
  return lower.startsWith('add task') || lower.startsWith('task add');
}

function extractTaskTitle(message) {
  return message.replace(/^(add task|task add)/i, '').trim();
}

function findTask(tasks, ref) {
  const clean = ref.trim();
  if (!clean) return null;
  return tasks.find(t => t.id === clean || t.title.toLowerCase() === clean.toLowerCase() || t.title.toLowerCase().includes(clean.toLowerCase()));
}

function isSearchCommand(lower) {
  return lower.startsWith('search ') || lower.startsWith('research ') || lower.startsWith('deep search ');
}

function stripLead(text, leads) {
  let x = text;
  for (const lead of leads) {
    if (x.toLowerCase().startsWith(lead)) {
      return x.slice(lead.length).trim();
    }
  }
  return x.trim();
}

async function doSerperSearch(query, env, depth = 'standard') {
  const diagnostics = [];
  if (!env.SERPER_API_KEY) {
    diagnostics.push('SERPER_API_KEY is missing.');
    return { ok: false, error: 'Web search is not configured.', diagnostics };
  }
  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.SERPER_API_KEY
      },
      body: JSON.stringify({ q: query, num: depth === 'advanced' ? 15 : 8 })
    });
    if (!response.ok) return { ok: false, error: 'Search provider is currently unavailable.', diagnostics };
    const data = await response.json();
    const results = (data.organic || []).slice(0, depth === 'advanced' ? 10 : 6).map((r, i) => ({
      rank: i + 1,
      title: r.title,
      link: r.link,
      snippet: r.snippet
    }));
    return {
      ok: true,
      payload: {
        query,
        depth,
        searchedAt: new Date().toISOString(),
        answerBox: data.answerBox || null,
        results
      },
      diagnostics
    };
  } catch {
    return { ok: false, error: 'Search provider encountered a temporary issue.', diagnostics };
  }
}

async function summarizeSearch(lastSearch, env) {
  const bullets = lastSearch.results.map(r => `- ${r.title}: ${r.snippet}`).join('\n');
  const prompt = `Summarize these search findings for a fashion brand operator in 6 concise bullets and include 3 action items.\nQuery: ${lastSearch.query}\nFindings:\n${bullets}`;
  const ai = await runTextModel(env, prompt, 500);
  if (!ai.ok) return 'Summary unavailable right now. Please review the search results directly.';
  return ai.text;
}

function isMarketingCommand(lower) {
  return ['daily social content', 'campaign package', 'product launch copy', 'hashtag pack', 'cta pack'].some(k => lower.includes(k));
}

async function buildMarketingPackage(command, env) {
  const diagnostics = [];
  const type = ['daily social content', 'campaign package', 'product launch copy', 'hashtag pack', 'cta pack'].find(t => command.toLowerCase().includes(t)) || 'campaign package';
  const prompt = `You are Alex, operator for Superb Wear Clothing. Return strict JSON with keys instagramCaption, facebookCaption, tiktokCaption, cta, hashtags(array of 15), subjectLine, campaignTheme, type. Tone: bold, urban, premium streetwear. Brand facts: founded 2017 by Randy in Chicago. Website superbwearclothing.com. Handles ${BRAND.instagram}, ${BRAND.tiktok}. Request: ${command}`;
  const ai = await runTextModel(env, prompt, 900);
  if (!ai.ok) {
    diagnostics.push('AI generation unavailable.');
    return { ok: false, error: 'Marketing generation is temporarily unavailable.', diagnostics };
  }
  const parsed = safeJson(ai.text);
  if (!parsed) {
    return {
      ok: true,
      package: {
        type,
        instagramCaption: ai.text.slice(0, 450),
        facebookCaption: ai.text.slice(0, 450),
        tiktokCaption: ai.text.slice(0, 300),
        cta: 'Shop the drop at superbwearclothing.com',
        hashtags: ['#SuperbWear', '#ChicagoStreetwear', '#PremiumStreetwear'],
        createdAt: new Date().toISOString()
      }
    };
  }
  return { ok: true, package: { ...parsed, type, createdAt: new Date().toISOString() } };
}

function isEmailCommand(lower) {
  return lower.startsWith('draft email') || lower.startsWith('rewrite email') || lower.startsWith('send email') || lower.includes('show last email');
}

async function handleEmailCommand(command, lower, env, state) {
  const diagnostics = [];
  if (lower.includes('show last email')) {
    return { ok: true, message: state.lastEmailDraft ? 'Last email loaded.' : 'No email draft found.', lastEmailDraft: state.lastEmailDraft || null, lastEmailStatus: state.lastEmailStatus || null, diagnostics };
  }

  if (lower.startsWith('draft email') || lower.startsWith('rewrite email')) {
    const cleanReq = command.replace(/^(draft email|rewrite email)/i, '').trim();
    const prompt = `Create a professional brand email for Superb Wear Clothing. Never include instruction phrases like "draft an email to" in the final body. Return strict JSON with: subject, text, html. Include spam-safe structure, concise paragraphs, and a confident operator voice. Context: ${cleanReq}`;
    const ai = await runTextModel(env, prompt, 1200);
    if (!ai.ok) return { ok: false, error: 'Email drafting is temporarily unavailable.', diagnostics };
    const parsed = safeJson(ai.text);
    let draft;
    if (parsed && parsed.subject && parsed.text && parsed.html) {
      draft = parsed;
    } else {
      draft = {
        subject: 'Superb Wear Clothing — Partnership Update',
        text: sanitizeEmailText(ai.text),
        html: `<div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;">${escapeHtml(sanitizeEmailText(ai.text)).replace(/\n/g, '<br/>')}</div>`
      };
    }
    draft.createdAt = new Date().toISOString();
    state.lastEmailDraft = draft;
    pushActivity(state, 'email-draft', { subject: draft.subject });
    return { ok: true, message: 'Email draft prepared.', lastEmailDraft: draft, diagnostics };
  }

  if (lower.startsWith('send email')) {
    if (!state.lastEmailDraft) return { ok: false, error: 'Create an email draft first.', diagnostics };
    const to = extractRecipient(command);
    if (!to) return { ok: false, error: 'Provide a recipient email using: send email to name@example.com', diagnostics };
    if (!env.RESEND_API_KEY) {
      diagnostics.push('RESEND_API_KEY is missing.');
      return { ok: false, error: 'Email sending is not configured.', diagnostics };
    }
    const fromEmail = env.SENDER_EMAIL || DEFAULT_FROM;
    const payload = {
      from: `${BRAND.name} <${fromEmail}>`,
      to: [to],
      subject: state.lastEmailDraft.subject,
      html: state.lastEmailDraft.html,
      text: state.lastEmailDraft.text
    };
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.id) {
        state.lastEmailStatus = {
          ok: false,
          at: new Date().toISOString(),
          recipient: to,
          subject: state.lastEmailDraft.subject,
          status: 'failed'
        };
        pushActivity(state, 'email-send-failed', { recipient: to });
        return { ok: false, error: 'Email sending encountered a provider issue.', diagnostics };
      }
      state.lastEmailStatus = {
        ok: true,
        at: new Date().toISOString(),
        recipient: to,
        subject: state.lastEmailDraft.subject,
        status: 'sent',
        receiptId: data.id
      };
      pushActivity(state, 'email-send', { recipient: to, receiptId: data.id });
      return { ok: true, message: `Email sent to ${to}.`, lastEmailStatus: state.lastEmailStatus, diagnostics };
    } catch {
      state.lastEmailStatus = { ok: false, at: new Date().toISOString(), recipient: to, status: 'failed' };
      return { ok: false, error: 'Email sending encountered a provider issue.', diagnostics };
    }
  }

  return { ok: false, error: 'Unsupported email command.', diagnostics };
}

function sanitizeEmailText(text) {
  return text
    .replace(/draft an email to/ig, '')
    .replace(/rewrite email/ig, '')
    .trim();
}

function extractRecipient(command) {
  const match = command.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : '';
}

function isFacebookPublishCommand(lower) {
  return lower.startsWith('publish to facebook') || lower.startsWith('publish facebook post') || lower.startsWith('publish image post');
}

async function handleFacebookPublish(command, env, state) {
  const diagnostics = [];
  if (!env.FB_PAGE_ACCESS_TOKEN) diagnostics.push('missing token');
  if (!env.FB_PAGE_ID) diagnostics.push('missing page id');
  if (diagnostics.length) {
    return { ok: false, error: 'Facebook publish failed due to missing token configuration.', diagnostics };
  }

  const caption = stripLead(command, ['publish to facebook', 'publish facebook post', 'publish image post']) || (state.lastMarketingPackage?.facebookCaption || 'New drop live now.');
  const isImagePost = command.toLowerCase().startsWith('publish image post');
  const now = new Date().toISOString();

  try {
    let endpoint = `https://graph.facebook.com/v20.0/${env.FB_PAGE_ID}/${isImagePost ? 'photos' : 'feed'}`;
    const params = new URLSearchParams({
      access_token: env.FB_PAGE_ACCESS_TOKEN,
      message: caption
    });

    if (isImagePost) {
      if (!state.lastUpload || !state.lastUpload.bucketKey) {
        return { ok: false, error: 'Upload a design first so I can process it.', diagnostics: ['upload failure'] };
      }
      const presigned = `https://dummy.invalid/${encodeURIComponent(state.lastUpload.bucketKey)}`;
      params.set('url', presigned);
    }

    const res = await fetch(endpoint, { method: 'POST', body: params });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = mapFacebookError(data);
      return { ok: false, error: msg, diagnostics: [msg.includes('permissions') ? 'permission error' : 'API rejection'] };
    }

    const postId = data.post_id || data.id;
    if (!postId) {
      return { ok: false, error: 'Facebook publish failed due to API rejection.', diagnostics: ['API rejection'] };
    }

    const receipt = {
      postId,
      caption,
      timestamp: now,
      pageId: env.FB_PAGE_ID,
      mode: isImagePost ? 'image' : 'text'
    };
    state.lastFacebookPost = receipt;
    pushActivity(state, 'facebook-post', { postId, mode: receipt.mode });
    return { ok: true, message: 'Facebook post published successfully.', facebookReceipt: receipt, diagnostics };
  } catch {
    return { ok: false, error: 'Facebook publish failed due to API rejection.', diagnostics: ['API rejection'] };
  }
}

function mapFacebookError(data) {
  const raw = JSON.stringify(data || {}).toLowerCase();
  if (raw.includes('oauth') || raw.includes('expired')) return 'Facebook publish failed due to expired token.';
  if (raw.includes('permission')) return 'Facebook publish failed due to permissions.';
  if (raw.includes('upload')) return 'Facebook publish failed due to upload failure.';
  return 'Facebook publish failed due to API rejection.';
}

async function verifyFacebookPost(env, state) {
  const diagnostics = [];
  if (!state.lastFacebookPost) return { ok: false, error: 'No Facebook receipt stored yet.', diagnostics };
  if (!env.FB_PAGE_ACCESS_TOKEN) {
    diagnostics.push('missing token');
    return { ok: false, error: 'Facebook verification requires a valid page token.', diagnostics };
  }
  try {
    const endpoint = `https://graph.facebook.com/v20.0/${encodeURIComponent(state.lastFacebookPost.postId)}?fields=id,created_time,message&access_token=${encodeURIComponent(env.FB_PAGE_ACCESS_TOKEN)}`;
    const res = await fetch(endpoint);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id) {
      return { ok: false, error: 'Facebook post verification failed.', diagnostics: ['API rejection'] };
    }
    return { ok: true, message: 'Last Facebook post verified.', facebookReceipt: state.lastFacebookPost, facebookVerification: data, diagnostics };
  } catch {
    return { ok: false, error: 'Facebook post verification failed.', diagnostics: ['API rejection'] };
  }
}

function instagramReadiness(env) {
  return {
    ready: !!env.IG_ACCESS_TOKEN && !!env.IG_ACCOUNT_ID,
    accountIdPresent: !!env.IG_ACCOUNT_ID,
    tokenPresent: !!env.IG_ACCESS_TOKEN,
    futurePublishingArchitecture: {
      createContainerEndpoint: env.IG_ACCOUNT_ID ? `https://graph.facebook.com/v20.0/${env.IG_ACCOUNT_ID}/media` : null,
      publishContainerEndpoint: env.IG_ACCOUNT_ID ? `https://graph.facebook.com/v20.0/${env.IG_ACCOUNT_ID}/media_publish` : null
    }
  };
}

async function createInstagramDraft(command, env) {
  const diagnostics = [];
  const prompt = `Create an Instagram caption draft for Superb Wear Clothing in bold urban premium streetwear tone. Include hook, value, CTA, and 12 hashtags. Request: ${command}`;
  const ai = await runTextModel(env, prompt, 700);
  if (!ai.ok) {
    diagnostics.push('AI binding is unavailable for draft generation.');
    return { ok: false, error: 'Instagram draft generation is temporarily unavailable.', diagnostics };
  }
  return {
    ok: true,
    draft: {
      caption: ai.text,
      generatedAt: new Date().toISOString(),
      readiness: instagramReadiness(env)
    },
    diagnostics
  };
}

function isImageCommand(lower) {
  const tags = [
    'upload artwork',
    'dtf cleanup',
    'embroidery prep',
    'true background removal',
    '4k upscale',
    'mockup generation',
    'generate new artwork',
    'image enhancement',
    'clean this for dtf',
    'make embroidery ready',
    'remove the background',
    'make it print ready',
    'put this on a hoodie'
  ];
  return tags.some(t => lower.includes(t));
}

function needsUploadedImage(lower) {
  return ['dtf', 'embroidery', 'background', 'upscale', 'mockup', 'print ready', 'hoodie'].some(k => lower.includes(k));
}

function inferImageWorkflow(lower) {
  if (lower.includes('dtf')) return 'dtf_cleanup';
  if (lower.includes('embroidery')) return 'embroidery_prep';
  if (lower.includes('background')) return 'background_removal';
  if (lower.includes('4k') || lower.includes('upscale')) return 'upscale_4k';
  if (lower.includes('mockup') || lower.includes('hoodie')) return 'mockup_generation';
  if (lower.includes('enhancement')) return 'image_enhancement';
  return 'image_generation';
}

function rewriteImagePrompt(command, workflow) {
  const base = {
    dtf_cleanup: 'Prepare this artwork for DTF printing: sharpen edges, improve contrast, clean transparency, preserve logo fidelity.',
    embroidery_prep: 'Simplify artwork for embroidery stitch readiness: reduce gradients, enforce bold regions, clean outlines, preserve brand identity.',
    background_removal: 'Remove background cleanly, isolate primary design subject with crisp transparent edges, no halo artifacts.',
    upscale_4k: 'Upscale this artwork to high detail print quality suitable for 4K output while preserving original design intent.',
    mockup_generation: 'Place this artwork naturally on a premium black hoodie apparel mockup with realistic fabric lighting and folds.',
    image_enhancement: 'Enhance this image for premium ecommerce quality with improved lighting, contrast, and clarity.',
    image_generation: 'Create a premium streetwear graphic artwork concept for Superb Wear Clothing with bold urban aesthetic.'
  };
  return `${base[workflow]} User request: ${command}`;
}

async function runImageWorkflow(command, lower, env, state) {
  const diagnostics = [];
  const workflow = inferImageWorkflow(lower);

  if (needsUploadedImage(lower) && (!state.lastUpload || !state.lastUpload.bucketKey)) {
    return { ok: false, error: 'Upload a design first so I can process it.', diagnostics };
  }

  if (!env.AI) {
    diagnostics.push('AI binding is not configured.');
    return { ok: false, error: 'Image processing temporarily unavailable', diagnostics };
  }

  const prompt = rewriteImagePrompt(command, workflow);
  let sourceB64 = null;
  if (needsUploadedImage(lower) && env.BUCKET && state.lastUpload?.bucketKey) {
    const obj = await env.BUCKET.get(state.lastUpload.bucketKey);
    if (obj) {
      const bin = await obj.arrayBuffer();
      sourceB64 = arrayBufferToBase64(bin);
    }
  }

  const imgResult = await runImageModel(env, prompt, sourceB64);
  if (!imgResult.ok || !imgResult.base64) {
    return { ok: false, error: 'Image processing temporarily unavailable', diagnostics };
  }

  if (!env.BUCKET) {
    state.lastGeneratedDesign = {
      workflow,
      generatedAt: new Date().toISOString(),
      stored: false
    };
    pushActivity(state, 'design-generated', { workflow, stored: false });
    return { ok: true, message: 'Image workflow completed. Storage is not connected, so output was returned inline.', image: { base64: imgResult.base64, mimeType: imgResult.mimeType || 'image/png' }, diagnostics };
  }

  const outKey = `generated/${Date.now()}-${workflow}.png`;
  const bytes = base64ToBytes(imgResult.base64);
  await env.BUCKET.put(outKey, bytes, { httpMetadata: { contentType: imgResult.mimeType || 'image/png' } });

  const receipt = {
    workflow,
    prompt,
    sourceKey: state.lastUpload?.bucketKey || null,
    outputKey: outKey,
    generatedAt: new Date().toISOString()
  };
  state.lastGeneratedDesign = receipt;
  pushActivity(state, 'design-generated', { workflow, outputKey: outKey });

  return {
    ok: true,
    message: `Image workflow complete: ${workflow}`,
    image: {
      key: outKey,
      mimeType: imgResult.mimeType || 'image/png',
      base64: imgResult.base64
    },
    receipt,
    diagnostics
  };
}

async function runTextModel(env, prompt, maxTokens = 800) {
  if (!env.AI) return { ok: false, text: '' };
  const models = ['@cf/meta/llama-3.1-8b-instruct', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'];
  for (const model of models) {
    try {
      const out = await env.AI.run(model, {
        messages: [
          { role: 'system', content: 'You are Alex, operator console executive for Superb Wear Clothing.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: maxTokens,
        temperature: 0.4
      });
      const text = out?.response || out?.result?.response || out?.text;
      if (text) return { ok: true, text };
    } catch {
    }
  }
  return { ok: false, text: '' };
}

async function runImageModel(env, prompt, sourceBase64 = null) {
  const attempts = [
    { model: '@cf/black-forest-labs/flux-1-schnell', mode: 'txt2img' },
    { model: '@cf/bytedance/stable-diffusion-xl-lightning', mode: sourceBase64 ? 'img2img' : 'txt2img' },
    { model: '@cf/stabilityai/stable-diffusion-xl-base-1.0', mode: sourceBase64 ? 'img2img' : 'txt2img' }
  ];

  for (const a of attempts) {
    try {
      const input = sourceBase64
        ? { prompt, image: sourceBase64, strength: 0.45, num_steps: 24 }
        : { prompt, num_steps: 24 };
      const out = await env.AI.run(a.model, input);
      const base64 = out?.image || out?.result?.image || out?.images?.[0] || out?.data?.[0]?.b64_json || null;
      const mimeType = out?.mimeType || 'image/png';
      if (base64) return { ok: true, base64, mimeType };
    } catch {
    }
  }
  return { ok: false };
}

async function operatorResponse(command, env, state) {
  const context = {
    brand: BRAND,
    lastUpload: state.lastUpload,
    lastCampaign: state.lastMarketingPackage,
    lastEmail: state.lastEmailStatus,
    lastFacebookPost: state.lastFacebookPost,
    tasks: state.tasks
  };
  const prompt = `You are Alex, a business operator console for Superb Wear Clothing. Respond like an executive operator in concise actionable style. Avoid chatbot framing. Request: ${command}\nContext:${JSON.stringify(context)}`;
  const ai = await runTextModel(env, prompt, 600);
  if (!ai.ok) return 'Operator command received. Core systems are available via dashboard modules (Production, Marketing, Social, Email, Tasks, Activity).';
  return ai.text;
}

function safeJson(text) {
  try {
    const trimmed = text.trim();
    const direct = JSON.parse(trimmed);
    return direct;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderApp() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>ALEX — SUPERB WEAR OPERATOR CONSOLE</title>
<style>
:root{--bg:#090909;--panel:#111111;--panel2:#171717;--line:#2b2b2b;--text:#f2f2f2;--muted:#9b9b9b;--accent:#e63946;--ok:#24d17d;--warn:#ffb020}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
.app{display:grid;grid-template-columns:260px 1fr;height:100vh}
.sidebar{background:#0c0c0c;border-right:1px solid var(--line);padding:20px;display:flex;flex-direction:column;gap:16px}
.brand{padding:8px 10px;background:linear-gradient(135deg,#1b1b1b,#111);border:1px solid var(--line);border-radius:12px}
.brand h1{font-size:16px;margin:0 0 6px;color:#fff}.brand p{margin:0;color:var(--muted);font-size:12px}
.nav{display:flex;flex-direction:column;gap:8px}
.nav button{background:#131313;border:1px solid var(--line);color:var(--text);text-align:left;padding:10px 12px;border-radius:10px;cursor:pointer}
.nav button.active,.nav button:hover{border-color:var(--accent);background:#191113}
.main{padding:20px;overflow:auto}
.top{display:flex;gap:12px;align-items:center;margin-bottom:16px}
.cmd{flex:1;display:flex;gap:10px}.cmd input{flex:1;padding:12px;border-radius:10px;border:1px solid var(--line);background:#0f0f0f;color:#fff}
.cmd button{background:var(--accent);border:0;color:#fff;padding:12px 16px;border-radius:10px;font-weight:700;cursor:pointer}
.cards{display:grid;grid-template-columns:repeat(12,1fr);gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px}
.card h3{margin:0 0 10px;font-size:14px}.muted{color:var(--muted);font-size:12px}
.kv{display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px}
.kv div{padding:8px;background:var(--panel2);border:1px solid var(--line);border-radius:8px}
.badge{display:inline-flex;align-items:center;padding:3px 8px;border-radius:999px;font-size:11px;border:1px solid var(--line);margin-right:6px}
.badge.ok{color:var(--ok);border-color:rgba(36,209,125,.35)}.badge.no{color:#ff7c88;border-color:rgba(255,124,136,.35)}
.actions{display:flex;flex-wrap:wrap;gap:8px}.actions button{background:#141414;color:#fff;border:1px solid var(--line);padding:9px 12px;border-radius:10px;cursor:pointer}
.actions button:hover{border-color:var(--accent)}
.w-6{grid-column:span 6}.w-12{grid-column:span 12}.w-4{grid-column:span 4}
pre{white-space:pre-wrap;background:#0d0d0d;border:1px solid var(--line);border-radius:10px;padding:10px;max-height:360px;overflow:auto}
.upload{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
img.preview{max-width:100%;max-height:220px;border:1px solid var(--line);border-radius:10px;background:#0a0a0a}
.load{display:none;color:var(--warn);font-size:12px}.load.on{display:block}
@media (max-width:980px){.app{grid-template-columns:1fr}.sidebar{position:sticky;top:0;z-index:5}.w-6,.w-4{grid-column:span 12}}
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand">
      <h1>ALEX — Operator Console</h1>
      <p>Superb Wear Clothing</p>
    </div>
    <nav class="nav" id="nav">
      <button data-panel="overview" class="active">Overview</button>
      <button data-panel="production">Production</button>
      <button data-panel="marketing">Marketing</button>
      <button data-panel="social">Social</button>
      <button data-panel="email">Email</button>
      <button data-panel="tasks">Tasks</button>
      <button data-panel="activity">Activity</button>
      <button data-panel="settings">Settings</button>
    </nav>
  </aside>
  <main class="main">
    <div class="top">
      <div class="cmd">
        <input id="cmd" placeholder="Run command (e.g. daily social content, publish to facebook, add task ...)" />
        <button id="runBtn">Run</button>
      </div>
      <div class="load" id="loading">Running operator workflow…</div>
    </div>

    <section id="panel-overview" class="panel"></section>
    <section id="panel-production" class="panel" style="display:none"></section>
    <section id="panel-marketing" class="panel" style="display:none"></section>
    <section id="panel-social" class="panel" style="display:none"></section>
    <section id="panel-email" class="panel" style="display:none"></section>
    <section id="panel-tasks" class="panel" style="display:none"></section>
    <section id="panel-activity" class="panel" style="display:none"></section>
    <section id="panel-settings" class="panel" style="display:none"></section>
  </main>
</div>
<script>
const state={dashboard:null,lastResponse:null,lastImage:null};
const $=s=>document.querySelector(s);
const panelNames=['overview','production','marketing','social','email','tasks','activity','settings'];

function showPanel(name){
  panelNames.forEach(n=>{
    const sec=$('#panel-'+n); if(sec) sec.style.display=n===name?'block':'none';
    const b=document.querySelector('[data-panel="'+n+'"]'); if(b) b.classList.toggle('active',n===name);
  });
}

$('#nav').addEventListener('click',e=>{if(e.target.matches('button[data-panel]'))showPanel(e.target.dataset.panel)});
$('#runBtn').addEventListener('click',()=>runCommand($('#cmd').value));
$('#cmd').addEventListener('keydown',e=>{if(e.key==='Enter')runCommand($('#cmd').value)});

async function runCommand(message){
  if(!message.trim())return;
  $('#loading').classList.add('on');
  try{
    const res=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message})});
    const data=await res.json();
    state.lastResponse=data;
    if(data.dashboard)state.dashboard=data.dashboard;
    renderAll();
  }catch(err){
    state.lastResponse={ok:false,error:'Request failed'};
    renderAll();
  }finally{
    $('#loading').classList.remove('on');
  }
}

function badge(v){return '<span class="badge '+(v?'ok':'no')+'">'+(v?'Connected':'Missing')+'</span>'}

function renderOverview(){
  const d=state.dashboard||{}; const c=d.connectedSystems||{};
  $('#panel-overview').innerHTML='\
  <div class="cards">\
    <div class="card w-6"><h3>Brand Overview</h3><div class="kv">\
      <div><strong>Brand</strong><br>'+((d.brand&&d.brand.name)||'Superb Wear Clothing')+'</div>\
      <div><strong>Founded</strong><br>'+((d.brand&&d.brand.founded)||'2017')+'</div>\
      <div><strong>Location</strong><br>'+((d.brand&&d.brand.location)||'Chicago, Illinois')+'</div>\
      <div><strong>Website</strong><br>'+((d.brand&&d.brand.website)||'https://superbwearclothing.com')+'</div>\
    </div></div>\
    <div class="card w-6"><h3>Connected Systems</h3>\
      <div>'+badge(c.ai)+' AI</div><div>'+badge(c.storage)+' Storage</div><div>'+badge(c.memory)+' Memory</div><div>'+badge(c.webSearch)+' Search</div><div>'+badge(c.email)+' Email</div><div>'+badge(c.facebook)+' Facebook</div><div>'+badge(c.instagram)+' Instagram</div>\
      <p class="muted">Last activity: '+((d.lastActivity&&d.lastActivity.type)?d.lastActivity.type+' @ '+d.lastActivity.at:'none')+'</p>\
      <p class="muted">Facebook connected: '+(d.facebookConnected?'yes':'no')+' • Instagram ready: '+((d.instagramReadiness&&d.instagramReadiness.ready)?'yes':'no')+'</p>\
    </div>\
    <div class="card w-12"><h3>Command Output</h3><pre>'+escapeHtml(JSON.stringify(state.lastResponse||{message:'Ready.'},null,2))+'</pre></div>\
  </div>';
}

function renderProduction(){
  const up=state.dashboard?.activity?.lastUpload;
  $('#panel-production').innerHTML='\
  <div class="cards">\
    <div class="card w-12"><h3>Production Studio</h3>\
      <div class="upload">\
        <input type="file" id="uploader" accept="image/*,.pdf,.svg,.ai,.psd" />\
        <button id="uploadBtn">Upload artwork</button>\
        <button data-cmd="DTF cleanup">DTF cleanup</button>\
        <button data-cmd="Embroidery prep">Embroidery prep</button>\
        <button data-cmd="True background removal">True background removal</button>\
        <button data-cmd="4K upscale">4K upscale</button>\
        <button data-cmd="Mockup generation">Mockup generation</button>\
      </div>\
      <p class="muted">Last upload: '+(up?up.fileName+' ('+(up.width||'?')+'x'+(up.height||'?')+')':'none')+'</p>\
      <div id="imgWrap"></div>\
    </div>\
  </div>';
  $('#uploadBtn').onclick=uploadFile;
  document.querySelectorAll('#panel-production button[data-cmd]').forEach(b=>b.onclick=()=>runCommand(b.dataset.cmd));
  if(state.lastResponse?.image?.base64){
    $('#imgWrap').innerHTML='<img class="preview" src="data:'+(state.lastResponse.image.mimeType||'image/png')+';base64,'+state.lastResponse.image.base64+'" />';
  }
}

async function uploadFile(){
  const file=$('#uploader').files[0]; if(!file)return;
  const fd=new FormData(); fd.append('file',file);
  $('#loading').classList.add('on');
  try{
    const res=await fetch('/api/upload',{method:'POST',body:fd});
    const data=await res.json();
    state.lastResponse=data;
    await runCommand('show dashboard');
  }catch(e){ state.lastResponse={ok:false,error:'Upload failed'}; renderAll(); }
  finally{$('#loading').classList.remove('on');}
}

function renderMarketing(){
  const m=state.dashboard?.activity?.lastCampaign;
  $('#panel-marketing').innerHTML='\
  <div class="cards">\
    <div class="card w-12"><h3>Marketing Studio</h3><div class="actions">\
      <button data-cmd="daily social content">Daily social content</button>\
      <button data-cmd="campaign package">Campaign package</button>\
      <button data-cmd="product launch copy">Product launch copy</button>\
      <button data-cmd="hashtag pack">Hashtag pack</button>\
      <button data-cmd="cta pack">CTA pack</button>\
    </div>\
    <p class="muted">Last campaign: '+(m?m.type+' @ '+m.createdAt:'none')+'</p>\
    <pre>'+escapeHtml(JSON.stringify(state.lastResponse?.marketing||m||{},null,2))+'</pre></div>\
  </div>';
  document.querySelectorAll('#panel-marketing button[data-cmd]').forEach(b=>b.onclick=()=>runCommand(b.dataset.cmd));
}

function renderSocial(){
  $('#panel-social').innerHTML='\
  <div class="cards">\
    <div class="card w-12"><h3>Social Console</h3><div class="actions">\
      <button data-cmd="publish to facebook Drop live now. Tap in at superbwearclothing.com">Publish to Facebook</button>\
      <button data-cmd="verify last facebook post">Verify last Facebook post</button>\
      <button data-cmd="show facebook receipt">Show Facebook receipt</button>\
      <button data-cmd="prepare instagram draft for tonight\'s launch">Prepare Instagram draft</button>\
      <button data-cmd="check instagram configuration">Check Instagram configuration</button>\
    </div><pre>'+escapeHtml(JSON.stringify(state.lastResponse?.facebookReceipt||state.lastResponse?.facebookVerification||state.lastResponse?.instagram||state.dashboard?.activity?.lastFacebookPost||{},null,2))+'</pre></div>\
  </div>';
  document.querySelectorAll('#panel-social button[data-cmd]').forEach(b=>b.onclick=()=>runCommand(b.dataset.cmd));
}

function renderEmail(){
  $('#panel-email').innerHTML='\
  <div class="cards">\
    <div class="card w-12"><h3>Email Console</h3><div class="actions">\
      <button data-cmd="draft email to a wholesale partner about new spring drop and minimum order quantities">Draft email</button>\
      <button data-cmd="rewrite email for a more premium tone">Rewrite email</button>\
      <button data-cmd="show last email">Show last email</button>\
      <button data-cmd="send email to hello@superbwearclothing.com">Send email</button>\
    </div><pre>'+escapeHtml(JSON.stringify(state.lastResponse?.lastEmailDraft||state.lastResponse?.lastEmailStatus||state.dashboard?.activity?.lastEmail||{},null,2))+'</pre></div>\
  </div>';
  document.querySelectorAll('#panel-email button[data-cmd]').forEach(b=>b.onclick=()=>runCommand(b.dataset.cmd));
}

function renderTasks(){
  const tasks=state.lastResponse?.tasks||state.dashboard?.tasks||[];
  $('#panel-tasks').innerHTML='\
  <div class="cards">\
    <div class="card w-12"><h3>Tasks</h3><div class="actions">\
      <button data-cmd="add task Review sample approvals with vendor">Add sample task</button>\
      <button data-cmd="list tasks">List tasks</button>\
    </div><p class="muted">Use command bar for custom tasks: add task..., mark done ...</p><pre>'+escapeHtml(JSON.stringify(tasks,null,2))+'</pre></div>\
  </div>';
  document.querySelectorAll('#panel-tasks button[data-cmd]').forEach(b=>b.onclick=()=>runCommand(b.dataset.cmd));
}

function renderActivity(){
  const act=state.dashboard?.activity||{};
  $('#panel-activity').innerHTML='\
  <div class="cards">\
    <div class="card w-12"><h3>Activity Log</h3><pre>'+escapeHtml(JSON.stringify(act,null,2))+'</pre></div>\
  </div>';
}

function renderSettings(){
  $('#panel-settings').innerHTML='\
  <div class="cards">\
    <div class="card w-6"><h3>Settings</h3><p class="muted">Theme: Dark operator console • Accent: Red</p><div class="actions"><button id="resetBtn">Reset Session Memory</button><button id="refreshBtn">Refresh Dashboard</button></div></div>\
    <div class="card w-6"><h3>Brand Coordinates</h3><div class="kv"><div><strong>Founder</strong><br>Randy</div><div><strong>Founded</strong><br>2017</div><div><strong>Website</strong><br>superbwearclothing.com</div><div><strong>Location</strong><br>Chicago, Illinois</div></div></div>\
  </div>';
  $('#resetBtn').onclick=async()=>{const r=await fetch('/api/reset',{method:'POST'});state.lastResponse=await r.json();await runCommand('show dashboard')};
  $('#refreshBtn').onclick=()=>runCommand('show dashboard');
}

function escapeHtml(s){return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}

function renderAll(){renderOverview();renderProduction();renderMarketing();renderSocial();renderEmail();renderTasks();renderActivity();renderSettings()}

runCommand('show dashboard');
</script>
</body>
</html>`;
}
