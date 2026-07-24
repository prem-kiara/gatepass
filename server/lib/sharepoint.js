'use strict';

/**
 * SharePoint / Microsoft Graph adapter.
 *
 * Follows the pattern already proven by the wealth app's nightly backup upload
 * (`~/wealth/app/src/integrations/sharepoint.js` on the VM): OAuth2
 * client-credentials against login.microsoftonline.com, token cached in-process.
 *
 * Credentials are NOT stored in this repo's .env. They are read at runtime from
 * AWS SSM using the EC2 instance role, so the secret never lands in a file here:
 *
 *   /dhanam/wealth/SHAREPOINT_TENANT_ID
 *   /dhanam/wealth/SHAREPOINT_CLIENT_ID
 *   /dhanam/wealth/SHAREPOINT_CLIENT_SECRET
 *   /dhanam/wealth/SHAREPOINT_BACKUP_DRIVE_ID   (the site's Documents library)
 *
 * The path is company-wide rather than app-specific because the Azure app
 * registration is shared; override with SHAREPOINT_SSM_PATH if it ever moves.
 * The registration already holds the application permission Files.ReadWrite.All
 * (admin-consented) that this needs — nothing new to grant.
 *
 * Env vars of the same names take precedence, which is what makes local
 * dry-running possible without any AWS access.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const SSM_PATH = process.env.SHAREPOINT_SSM_PATH || '/dhanam/wealth';
const KEYS = [
  'SHAREPOINT_TENANT_ID',
  'SHAREPOINT_CLIENT_ID',
  'SHAREPOINT_CLIENT_SECRET',
  'SHAREPOINT_BACKUP_DRIVE_ID',
];

let _config = null;
let _tokenCache = { token: null, expiresAt: 0 };

/**
 * Resolves credentials once per process: environment first, then SSM.
 * Values are held in memory only and never logged.
 */
async function getConfig() {
  if (_config) return _config;

  const cfg = {};
  const missing = [];
  for (const key of KEYS) {
    if (process.env[key]) cfg[key] = process.env[key];
    else missing.push(key);
  }

  if (missing.length > 0) {
    const names = missing.map((k) => `${SSM_PATH}/${k}`);
    let stdout;
    try {
      const res = await execFileAsync('aws', [
        'ssm', 'get-parameters',
        '--names', ...names,
        '--with-decryption',
        '--output', 'json',
      ], { maxBuffer: 1024 * 1024 });
      stdout = res.stdout;
    } catch (err) {
      throw new Error(
        `Could not read SharePoint credentials from SSM (${SSM_PATH}). ` +
        'On the VM this needs the instance role; locally, set the SHAREPOINT_* env vars instead.'
      );
    }

    const parsed = JSON.parse(stdout);
    for (const p of parsed.Parameters || []) {
      const key = p.Name.split('/').pop();
      cfg[key] = p.Value;
    }
    const stillMissing = KEYS.filter((k) => !cfg[k]);
    if (stillMissing.length > 0) {
      throw new Error(`SharePoint credentials not found: ${stillMissing.join(', ')}`);
    }
  }

  _config = cfg;
  return cfg;
}

async function getToken() {
  const now = Date.now();
  // Refresh a little early so a long upload run never fails mid-flight.
  if (_tokenCache.token && now < _tokenCache.expiresAt - 5 * 60 * 1000) {
    return _tokenCache.token;
  }

  const cfg = await getConfig();
  const body = new URLSearchParams({
    client_id: cfg.SHAREPOINT_CLIENT_ID,
    client_secret: cfg.SHAREPOINT_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const r = await fetch(
    `https://login.microsoftonline.com/${cfg.SHAREPOINT_TENANT_ID}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }
  );
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`SharePoint token request failed (${r.status}): ${detail.slice(0, 300)}`);
  }

  const j = await r.json();
  _tokenCache = { token: j.access_token, expiresAt: now + (Number(j.expires_in) || 3600) * 1000 };
  return _tokenCache.token;
}

async function getDriveId() {
  return (await getConfig()).SHAREPOINT_BACKUP_DRIVE_ID;
}

function encodePath(pathInDrive) {
  return String(pathInDrive)
    .replace(/^\/+/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

/**
 * Uploads a buffer to `pathInDrive`, e.g. "GatePass/2026-07-24/0930_Suresh.jpg".
 *
 * Graph's PUT-to-path creates any missing intermediate folders, so the daily
 * date folder comes into being on the first upload of that day — there is no
 * separate create-folder step to get wrong or to race on.
 *
 * Simple PUT is valid up to 250MB; visitor photos are ~200KB.
 */
async function uploadFile(pathInDrive, buffer, { contentType = 'application/octet-stream' } = {}) {
  const token = await getToken();
  const driveId = await getDriveId();
  const url =
    `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}` +
    `/root:/${encodePath(pathInDrive)}:/content`;

  const r = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body: buffer,
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`SharePoint upload failed (${r.status}) for ${pathInDrive}: ${detail.slice(0, 300)}`);
  }
  return r.json();
}

/** Used only to clean up after the connection self-test. */
async function deleteByPath(pathInDrive) {
  const token = await getToken();
  const driveId = await getDriveId();
  const url =
    `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}` +
    `/root:/${encodePath(pathInDrive)}`;

  const r = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok && r.status !== 404) {
    const detail = await r.text().catch(() => '');
    throw new Error(`SharePoint delete failed (${r.status}): ${detail.slice(0, 200)}`);
  }
  return true;
}

module.exports = { getConfig, getToken, getDriveId, uploadFile, deleteByPath };
