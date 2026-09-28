#!/usr/bin/env node
'use strict';

/**
 * Jobs4Youth Opportunity Harvester
 *
 * Production-safe first version:
 * - Imports jobs from the official ReliefWeb API v2.
 * - Supports optional authorised JSON feeds through HARVESTER_JSON_FEEDS.
 * - Normalises records to the public.opportunities schema.
 * - Upserts through the Supabase REST API using source_type + external_id.
 * - Supports dry runs and avoids HTML scraping.
 *
 * Required environment variables:
 *   SUPABASE_URL=https://YOUR_PROJECT.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
 *   RELIEFWEB_APPNAME=jobs4youth.org
 *
 * Optional environment variables:
 *   HARVEST_DRY_RUN=true
 *   HARVEST_LIMIT=100
 *   HARVEST_DAYS_BACK=14
 *   HARVEST_COUNTRIES=Malawi,Kenya,Uganda,Tanzania,Rwanda,Zambia,Zimbabwe,Mozambique,Ethiopia,Nigeria,Ghana,Remote
 *   HARVEST_STATUS=Verified
 *   HARVESTER_JSON_FEEDS=[{"name":"Partner Feed","url":"https://partner.example/jobs.json","token":"..."}]
 */

const CONFIG = {
  supabaseUrl: cleanUrl(process.env.SUPABASE_URL || ''),
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  reliefWebAppName: process.env.RELIEFWEB_APPNAME || 'jobs4youth.org',
  dryRun: String(process.env.HARVEST_DRY_RUN || 'false').toLowerCase() === 'true',
  limit: clampNumber(process.env.HARVEST_LIMIT, 100, 1, 500),
  daysBack: clampNumber(process.env.HARVEST_DAYS_BACK, 14, 1, 90),
  defaultStatus: process.env.HARVEST_STATUS || 'Verified',
  countries: parseCsv(process.env.HARVEST_COUNTRIES || 'Malawi,Kenya,Uganda,Tanzania,Rwanda,Zambia,Zimbabwe,Mozambique,Ethiopia,Nigeria,Ghana,Sierra Leone,Liberia,Senegal,Côte d’Ivoire,South Africa,Remote'),
  jsonFeeds: parseJsonFeeds(process.env.HARVESTER_JSON_FEEDS || '[]')
};

const AFRICAN_COUNTRIES = new Set([
  'Algeria','Angola','Benin','Botswana','Burkina Faso','Burundi','Cabo Verde','Cameroon',
  'Central African Republic','Chad','Comoros','Congo','Democratic Republic of the Congo',
  "Côte d’Ivoire",'Djibouti','Egypt','Equatorial Guinea','Eritrea','Eswatini','Ethiopia',
  'Gabon','Gambia','Ghana','Guinea','Guinea-Bissau','Kenya','Lesotho','Liberia','Libya',
  'Madagascar','Malawi','Mali','Mauritania','Mauritius','Morocco','Mozambique','Namibia',
  'Niger','Nigeria','Rwanda','Sao Tome and Principe','Senegal','Seychelles','Sierra Leone',
  'Somalia','South Africa','South Sudan','Sudan','Tanzania','Togo','Tunisia','Uganda',
  'Zambia','Zimbabwe'
]);

function cleanUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

function parseCsv(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function parseJsonFeeds(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(x => x && x.name && x.url) : [];
  } catch (error) {
    console.warn('HARVESTER_JSON_FEEDS is invalid JSON; optional partner feeds are disabled.');
    return [];
  }
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function isoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function isoTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function first(items, fallback = '') {
  return Array.isArray(items) && items.length ? items[0] : fallback;
}

function names(items) {
  return (Array.isArray(items) ? items : [])
    .map(item => typeof item === 'string' ? item : item?.name)
    .filter(Boolean);
}

function inferCategory(title, careerCategories = []) {
  const text = `${title || ''} ${careerCategories.join(' ')}`.toLowerCase();
  if (/scholarship|studentship/.test(text)) return 'Scholarship';
  if (/fellowship|fellow\b/.test(text)) return 'Fellowship';
  if (/internship|intern\b/.test(text)) return 'Internship';
  if (/apprentice/.test(text)) return 'Apprenticeship';
  if (/volunteer/.test(text)) return 'Volunteer';
  if (/consultan/.test(text)) return 'Job';
  return 'Job';
}

function inferExperience(experienceNames = [], title = '') {
  const text = `${experienceNames.join(' ')} ${title}`.toLowerCase();
  if (/0.?2|entry|intern|graduate|junior/.test(text)) return 'Entry Level';
  if (/3.?4|3.?5|mid/.test(text)) return '3–5 Years';
  if (/5|6|7|8|9|10|senior|director|head|lead/.test(text)) return '5+ Years';
  return '';
}

function inferEducation(description = '') {
  const text = String(description).toLowerCase();
  if (/ph\.?d|doctorate/.test(text)) return 'PhD';
  if (/master'?s|msc|ma degree/.test(text)) return "Master's Degree";
  if (/bachelor'?s|undergraduate degree|bsc|ba degree/.test(text)) return "Bachelor's Degree";
  if (/diploma/.test(text)) return 'Diploma';
  if (/certificate/.test(text)) return 'Certificate';
  return '';
}

function inferSkills(description = '', categories = []) {
  const known = [
    'Data Analysis','Data Science','Python','SQL','Power BI','Monitoring and Evaluation',
    'Project Management','Research','Statistics','Economics','Agriculture','Agribusiness',
    'Communications','Finance','Human Resources','Logistics','Procurement','Public Health',
    'Climate Change','Food Security','GIS','Machine Learning'
  ];
  const text = `${description} ${categories.join(' ')}`.toLowerCase();
  const detected = known.filter(skill => text.includes(skill.toLowerCase()));
  return [...new Set([...detected, ...categories])].slice(0, 15).join(', ');
}

function locationFromReliefWeb(fields) {
  const countryNames = names(fields.country);
  const city = first(names(fields.city));
  const country = countryNames[0] || (fields.remote ? 'Remote' : '');
  return { country, region: city || '' };
}

function relevantToConfiguredCountries(country, description = '') {
  if (!CONFIG.countries.length) return true;
  if (country === 'Remote') return true;
  if (CONFIG.countries.includes(country)) return true;
  const lower = String(description).toLowerCase();
  return CONFIG.countries.some(item => lower.includes(item.toLowerCase()));
}

function normalizeReliefWeb(item) {
  const fields = item?.fields || {};
  const title = fields.title || `ReliefWeb opportunity ${item?.id || ''}`;
  const description = stripHtml(fields.body || fields.description || '');
  const careerCategories = names(fields['career_categories'] || fields.career_categories);
  const experienceNames = names(fields.experience);
  const organisations = names(fields.source);
  const location = locationFromReliefWeb(fields);
  const sourceUrl = fields.url || `https://reliefweb.int/job/${item.id}`;
  const deadline = isoDate(fields.date?.closing || fields.date?.deadline);
  const createdAt = isoTimestamp(fields.date?.created || fields.date?.original || new Date());

  return {
    posted_by: null,
    title,
    organization_name: organisations.join(', ') || 'ReliefWeb-listed organisation',
    country: location.country,
    region: location.region,
    opportunity_type: inferCategory(title, careerCategories),
    opportunity_category: inferCategory(title, careerCategories),
    education_requirement: inferEducation(description),
    experience_requirement: inferExperience(experienceNames, title),
    deadline,
    expiry_date: deadline,
    compensation: null,
    work_arrangement: location.country === 'Remote' ? 'Remote' : null,
    duration: '',
    required_skills: inferSkills(description, careerCategories),
    benefits: null,
    learning_outcomes: null,
    application_link: sourceUrl,
    description: description.slice(0, 12000) || `See the original listing on ReliefWeb: ${sourceUrl}`,
    status: CONFIG.defaultStatus,
    source_name: 'ReliefWeb',
    source_type: 'reliefweb_api',
    source_url: sourceUrl,
    external_id: String(item.id),
    imported: true,
    fetched_at: new Date().toISOString(),
    created_at: createdAt,
    updated_at: new Date().toISOString()
  };
}

async function fetchJson(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

async function harvestReliefWeb() {
  const cutoff = new Date(Date.now() - CONFIG.daysBack * 86400000).toISOString();
  const endpoint = `https://api.reliefweb.int/v2/jobs?appname=${encodeURIComponent(CONFIG.reliefWebAppName)}`;
  const body = {
    limit: CONFIG.limit,
    offset: 0,
    fields: {
      include: [
        'title','body','url','source','country','city','career_categories','experience',
        'date.created','date.original','date.closing'
      ]
    },
    filter: {
      field: 'date.created',
      value: { from: cutoff }
    },
    sort: ['date.created:desc']
  };

  const payload = await fetchJson(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Jobs4Youth-Harvester/1.0' },
    body: JSON.stringify(body)
  });

  const records = (payload?.data || []).map(normalizeReliefWeb);
  return records.filter(record =>
    record.title && record.external_id &&
    relevantToConfiguredCountries(record.country, `${record.title} ${record.description}`)
  );
}

function normalizePartnerRecord(item, feed) {
  const title = item.title || item.name || '';
  const deadline = isoDate(item.deadline || item.expiry_date || item.closing_date);
  const description = stripHtml(item.description || item.body || item.summary || '');
  const sourceUrl = item.url || item.source_url || item.application_link || '';
  const externalId = String(item.external_id || item.id || sourceUrl || title).trim();
  const category = item.opportunity_category || item.opportunity_type || inferCategory(title);

  return {
    posted_by: null,
    title,
    organization_name: item.organization_name || item.organization || feed.name,
    country: item.country || '',
    region: item.region || item.city || '',
    opportunity_type: category,
    opportunity_category: category,
    education_requirement: item.education_requirement || inferEducation(description),
    experience_requirement: item.experience_requirement || '',
    deadline,
    expiry_date: deadline,
    compensation: item.compensation || null,
    work_arrangement: item.work_arrangement || null,
    duration: item.duration || '',
    required_skills: Array.isArray(item.required_skills) ? item.required_skills.join(', ') : (item.required_skills || inferSkills(description)),
    benefits: item.benefits || null,
    learning_outcomes: item.learning_outcomes || null,
    application_link: item.application_link || sourceUrl,
    description: description.slice(0, 12000),
    status: item.status || CONFIG.defaultStatus,
    source_name: feed.name,
    source_type: feed.type || 'partner_json_feed',
    source_url: sourceUrl,
    external_id: externalId,
    imported: true,
    fetched_at: new Date().toISOString(),
    created_at: isoTimestamp(item.created_at || item.published_at || new Date()),
    updated_at: new Date().toISOString()
  };
}

async function harvestPartnerFeed(feed) {
  const headers = { accept: 'application/json', 'user-agent': 'Jobs4Youth-Harvester/1.0' };
  if (feed.token) headers.authorization = `Bearer ${feed.token}`;
  const payload = await fetchJson(feed.url, { headers });
  const items = Array.isArray(payload) ? payload : (payload?.data || payload?.items || payload?.jobs || []);
  if (!Array.isArray(items)) throw new Error(`${feed.name} did not return an array or a recognised data/items/jobs array.`);
  return items
    .map(item => normalizePartnerRecord(item, feed))
    .filter(record => record.title && record.external_id && relevantToConfiguredCountries(record.country, `${record.title} ${record.description}`));
}

function deduplicate(records) {
  const map = new Map();
  for (const record of records) {
    const key = `${record.source_type}::${record.external_id}`;
    map.set(key, record);
  }
  return [...map.values()];
}

async function upsertSupabase(records) {
  if (!records.length) return { written: 0 };
  if (CONFIG.dryRun) {
    console.log(JSON.stringify(records.slice(0, 5), null, 2));
    return { written: 0 };
  }
  if (!CONFIG.supabaseUrl || !CONFIG.serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required unless HARVEST_DRY_RUN=true.');
  }

  const batchSize = 100;
  let written = 0;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    await fetchJson(
      `${CONFIG.supabaseUrl}/rest/v1/opportunities?on_conflict=source_type,external_id`,
      {
        method: 'POST',
        headers: {
          apikey: CONFIG.serviceRoleKey,
          authorization: `Bearer ${CONFIG.serviceRoleKey}`,
          'content-type': 'application/json',
          prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(batch)
      }
    );
    written += batch.length;
  }
  return { written };
}

async function main() {
  const startedAt = new Date();
  const all = [];
  const failures = [];

  console.log(`[Jobs4Youth] Harvest started ${startedAt.toISOString()}`);
  console.log(`[Jobs4Youth] Mode: ${CONFIG.dryRun ? 'DRY RUN' : 'WRITE'}`);

  try {
    const reliefWeb = await harvestReliefWeb();
    all.push(...reliefWeb);
    console.log(`[ReliefWeb] Normalised ${reliefWeb.length} relevant records.`);
  } catch (error) {
    failures.push({ source: 'ReliefWeb', error: error.message });
    console.error(`[ReliefWeb] ${error.message}`);
  }

  for (const feed of CONFIG.jsonFeeds) {
    try {
      const records = await harvestPartnerFeed(feed);
      all.push(...records);
      console.log(`[${feed.name}] Normalised ${records.length} relevant records.`);
    } catch (error) {
      failures.push({ source: feed.name, error: error.message });
      console.error(`[${feed.name}] ${error.message}`);
    }
  }

  const records = deduplicate(all);
  const result = await upsertSupabase(records);
  const summary = {
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    dry_run: CONFIG.dryRun,
    normalised: all.length,
    unique: records.length,
    written: result.written,
    failures
  };
  console.log('[Jobs4Youth] Summary');
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length && !records.length) process.exitCode = 1;
}

main().catch(error => {
  console.error('[Jobs4Youth] Fatal:', error);
  process.exitCode = 1;
});
