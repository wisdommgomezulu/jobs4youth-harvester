#!/usr/bin/env node
'use strict';

/*
  Jobs4Youth Malawi Job Harvester
  - Collects public Malawi job listing links from CareerAd Malawi and Malawi Living Hub.
  - Reads JobPosting structured data when a source publishes it.
  - Stores a short summary and ALWAYS links users back to the original source.
  - Does not copy full vacancy text.
  - Uses no npm packages. Node.js 20+ only.
*/

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const DRY_RUN = String(process.env.HARVEST_DRY_RUN || 'false').toLowerCase() === 'true';
const MAX_JOBS = Math.max(1, Math.min(100, Number(process.env.HARVEST_LIMIT || 50)));

const SOURCES = [
  {
    name: 'CareerAd Malawi',
    listUrls: [
      'https://www.careeradmw.com/jobs',
      'https://www.careeradmw.com/jobs?page=2',
      'https://www.careeradmw.com/jobs?page=3'
    ],
    jobUrlPattern: /^https:\/\/www\.careeradmw\.com\/jobs\/[a-z0-9-]+\/?$/i
  },
  {
    name: 'Malawi Living Hub',
    listUrls: ['https://malawilivinghub.com/jobs'],
    jobUrlPattern: /^https:\/\/malawilivinghub\.com\/jobs\/[a-z0-9-]+\/?$/i
  }
];

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeJsonLd(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'");
}

function toAbsoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).href.split('#')[0];
  } catch {
    return '';
  }
}

function isoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function isoTime(value) {
  const d = value ? new Date(value) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function slugFromUrl(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).pop() || url;
  } catch {
    return url;
  }
}

function titleFromSlug(slug) {
  return String(slug || '')
    .replace(/-[a-z0-9]{6,10}$/i, '')
    .replace(/-\d{8,}$/g, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

function inferCategory(title) {
  const text = String(title || '').toLowerCase();
  if (/internship|\bintern\b/.test(text)) return 'Internship';
  if (/scholarship|studentship/.test(text)) return 'Scholarship';
  if (/fellowship|\bfellow\b/.test(text)) return 'Fellowship';
  if (/volunteer/.test(text)) return 'Volunteer';
  if (/apprentice/.test(text)) return 'Apprenticeship';
  if (/training|course|bootcamp/.test(text)) return 'Training';
  return 'Job';
}

function locationFromJson(value) {
  const locations = Array.isArray(value) ? value : value ? [value] : [];
  const first = locations[0] || {};
  const address = first.address || first.location?.address || {};
  const region = address.addressLocality || address.addressRegion || '';
  const countryValue = address.addressCountry;
  const country = typeof countryValue === 'string'
    ? countryValue
    : countryValue?.name || 'Malawi';
  return { region, country: /malawi|mw/i.test(country) ? 'Malawi' : country };
}

function organizationFromJson(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.name || value.legalName || '';
}

function extractJsonLd(html) {
  const blocks = [];
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html))) {
    try {
      const parsed = JSON.parse(decodeJsonLd(match[1]).trim());
      blocks.push(parsed);
    } catch {
      // Ignore malformed structured data and use the safe fallback.
    }
  }
  return blocks;
}

function flattenJsonLd(nodes) {
  const out = [];
  const visit = node => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== 'object') return;
    out.push(node);
    if (Array.isArray(node['@graph'])) node['@graph'].forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

function findJobPosting(html) {
  return flattenJsonLd(extractJsonLd(html)).find(node => {
    const type = node['@type'];
    return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
  }) || null;
}

function metaContent(html, key, attribute = 'property') {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+${attribute}=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+${attribute}=["']${escaped}["'][^>]*>`, 'i')
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return stripHtml(match[1]);
  }
  return '';
}

function pageTitle(html, url) {
  const og = metaContent(html, 'og:title');
  if (og) return og.replace(/\s*[|–-]\s*CareerAd.*$/i, '').replace(/\s*[|–-]\s*Malawi Living Hub.*$/i, '').trim();
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]).split('|')[0].trim() : titleFromSlug(slugFromUrl(url));
}

function uniqueId(sourceName, url) {
  return `${sourceName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${slugFromUrl(url)}`;
}

function shortSummary(description, sourceName) {
  const clean = stripHtml(description);
  const summary = clean ? clean.slice(0, 650) : 'Open the original source listing to read the full vacancy details and application instructions.';
  return `${summary}${summary.endsWith('.') ? '' : '.'} Source: ${sourceName}. Always verify the deadline and application instructions on the original listing.`;
}

async function fetchText(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'en-GB,en;q=0.9',
        'user-agent': 'Mozilla/5.0 (compatible; Jobs4YouthBot/1.0; +https://www.jobs4youth.org)'
      }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractJobLinks(html, listUrl, source) {
  const links = new Set();
  const regex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = regex.exec(html))) {
    const url = toAbsoluteUrl(match[1], listUrl).replace(/\/$/, '');
    if (source.jobUrlPattern.test(url)) links.add(url);
  }
  return [...links];
}

function normalizeJob(html, url, source) {
  const job = findJobPosting(html);
  const title = stripHtml(job?.title || job?.name || pageTitle(html, url));
  const location = locationFromJson(job?.jobLocation || job?.applicantLocationRequirements);
  const category = inferCategory(title);
  const deadline = isoDate(job?.validThrough);
  const posted = isoTime(job?.datePosted);
  const organisation = organizationFromJson(job?.hiringOrganization) || 'See original source';
  const description = shortSummary(job?.description || metaContent(html, 'og:description') || metaContent(html, 'description', 'name'), source.name);

  return {
    posted_by: null,
    title,
    organization_name: organisation,
    country: 'Malawi',
    region: location.region || '',
    opportunity_type: category,
    opportunity_category: category,
    education_requirement: '',
    experience_requirement: '',
    deadline,
    expiry_date: deadline,
    compensation: null,
    work_arrangement: /remote|telecommute/i.test(`${job?.jobLocationType || ''} ${description}`) ? 'Remote' : null,
    duration: '',
    required_skills: '',
    benefits: null,
    learning_outcomes: null,
    application_link: url,
    description,
    status: 'Verified',
    source_name: source.name,
    source_type: 'malawi_public_listing',
    source_url: url,
    external_id: uniqueId(source.name, url),
    imported: true,
    fetched_at: new Date().toISOString(),
    created_at: posted,
    updated_at: new Date().toISOString()
  };
}

async function harvestSource(source) {
  const links = new Set();
  for (const listUrl of source.listUrls) {
    const html = await fetchText(listUrl);
    extractJobLinks(html, listUrl, source).forEach(url => links.add(url));
  }

  const selected = [...links].slice(0, MAX_JOBS);
  const jobs = [];
  for (const url of selected) {
    try {
      const html = await fetchText(url);
      const job = normalizeJob(html, url, source);
      if (job.title && job.source_url) jobs.push(job);
    } catch (error) {
      console.warn(`[${source.name}] Skipped ${url}: ${error.message}`);
    }
  }
  return jobs;
}

async function supabaseUpsert(records) {
  if (!records.length) return 0;
  if (DRY_RUN) {
    console.log(JSON.stringify(records.slice(0, 5), null, 2));
    return 0;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY GitHub secret.');
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/opportunities?on_conflict=source_type,external_id`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(records)
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return records.length;
}

async function main() {
  console.log(`[Jobs4Youth] Malawi harvest started. Mode: ${DRY_RUN ? 'DRY RUN' : 'WRITE'}`);
  const allJobs = [];
  const failures = [];

  for (const source of SOURCES) {
    try {
      const jobs = await harvestSource(source);
      allJobs.push(...jobs);
      console.log(`[${source.name}] Found ${jobs.length} Malawi listings.`);
    } catch (error) {
      failures.push({ source: source.name, error: error.message });
      console.error(`[${source.name}] ${error.message}`);
    }
  }

  const deduped = [...new Map(allJobs.map(job => [`${job.source_type}:${job.external_id}`, job])).values()];
  const written = await supabaseUpsert(deduped);

  console.log(JSON.stringify({
    country: 'Malawi',
    found: allJobs.length,
    unique: deduped.length,
    written,
    failures
  }, null, 2));

  if (!deduped.length) process.exitCode = 1;
}

main().catch(error => {
  console.error('[Jobs4Youth] Fatal:', error.message);
  process.exitCode = 1;
});
