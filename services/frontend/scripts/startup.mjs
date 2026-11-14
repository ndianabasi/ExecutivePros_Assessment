import { mkdir, writeFile } from 'node:fs/promises'

/**
 * Validates and normalizes a browser-facing service origin from the environment.
 *
 * @param {string} key - Environment variable containing the origin.
 * @returns {string} The normalized HTTP or HTTPS origin.
 * @throws {Error} When the value is missing or is not a browser-reachable origin.
 */
function origin(key) {
  const value = process.env[key]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${key} is required`)
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${key} must be a browser-reachable HTTP(S) origin`)
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${key} must be an origin without credentials, path, query or fragment`)
  }
  if (['api', 'provider', 'docs', 'frontend', 'queue', 'mailpit'].includes(parsed.hostname)) {
    throw new Error(`${key} must not use a Compose-only service name`)
  }
  return parsed.origin
}

const config = {
  API_ORIGIN: origin('API_ORIGIN'),
  PROVIDER_ORIGIN: origin('PROVIDER_ORIGIN'),
  DOCS_ORIGIN: origin('DOCS_ORIGIN'),
  MAILPIT_ORIGIN: origin('MAILPIT_ORIGIN'),
}
const jsonPath = process.env.FRONTEND_CONFIG_PATH ?? '/tmp/frontend-config.json'
const nginxPath = process.env.FRONTEND_NGINX_CONFIG_PATH ?? '/tmp/nginx.conf'
const headersPath = process.env.FRONTEND_HEADERS_PATH ?? '/tmp/security-headers.conf'
const tempRoot = process.env.FRONTEND_TMP_PATH ?? '/tmp'
await mkdir(`${tempRoot}/client_temp`, { recursive: true })
await mkdir(`${tempRoot}/proxy_temp`, { recursive: true })
await mkdir(`${tempRoot}/fastcgi_temp`, { recursive: true })
await mkdir(`${tempRoot}/uwsgi_temp`, { recursive: true })
await mkdir(`${tempRoot}/scgi_temp`, { recursive: true })
await writeFile(jsonPath, `${JSON.stringify(config)}\n`, { mode: 0o644 })
await writeFile(
  headersPath,
  [
    `add_header Content-Security-Policy "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${config.API_ORIGIN}; frame-src ${config.PROVIDER_ORIGIN}" always;`,
    'add_header X-Content-Type-Options nosniff always;',
    'add_header Referrer-Policy no-referrer always;',
    'add_header X-Frame-Options DENY always;',
  ].join('\n') + '\n',
)
await writeFile(
  nginxPath,
  `worker_processes 1;
daemon off;
pid /tmp/nginx.pid;
error_log stderr warn;
events { worker_connections 512; }
http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  access_log /dev/stdout;
  sendfile on;
  server_tokens off;
  client_body_temp_path ${tempRoot}/client_temp;
  proxy_temp_path ${tempRoot}/proxy_temp;
  fastcgi_temp_path ${tempRoot}/fastcgi_temp;
  uwsgi_temp_path ${tempRoot}/uwsgi_temp;
  scgi_temp_path ${tempRoot}/scgi_temp;
  server {
    listen 8080;
    root /usr/share/nginx/html;
    include ${headersPath};
    location = /health/ready { include ${headersPath}; add_header Cache-Control no-store always; if (!-f ${jsonPath}) { return 503; } default_type text/plain; return 200 'ready'; }
    location = /health/live { include ${headersPath}; add_header Cache-Control no-store always; default_type text/plain; return 200 'live'; }
    location = /config.json { include ${headersPath}; add_header Cache-Control no-store always; default_type application/json; alias ${jsonPath}; }
    location = /index.html { include ${headersPath}; add_header Cache-Control no-store always; try_files $uri =404; }
    location /assets/ { include ${headersPath}; add_header Cache-Control 'public, max-age=31536000, immutable' always; try_files $uri =404; }
    location = /health.html { include ${headersPath}; add_header Cache-Control no-store always; default_type text/plain; try_files $uri =404; }
    location / { include ${headersPath}; add_header Cache-Control no-store always; try_files $uri $uri/ /index.html; }
  }
}
`,
)
