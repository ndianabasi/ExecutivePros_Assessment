import { writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'

const value = process.env.API_ORIGIN
if (!value || value !== value.trim()) throw new Error('API_ORIGIN is required')
let parsed
try { parsed = new URL(value) } catch { throw new Error('API_ORIGIN must be an absolute HTTP(S) origin') }
const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
  throw new Error('API_ORIGIN must contain only an absolute HTTP(S) origin')
}
if (!isIP(hostname) && hostname !== 'localhost' && !hostname.includes('.')) throw new Error('API_ORIGIN must be browser-reachable; bare Compose service names are not allowed')

const origin = parsed.origin
const runtimeDir = process.env.RUNTIME_DIR ?? '/tmp'
await writeFile(join(runtimeDir, 'docs-config.json'), `${JSON.stringify({ API_ORIGIN: origin })}\n`, { mode: 0o444 })
const securityHeaders = `add_header Content-Security-Policy "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ${origin}" always;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy no-referrer always;
add_header X-Frame-Options DENY always;`
const template = `
pid /tmp/nginx.pid;
worker_processes 1;
daemon off;
error_log /dev/stderr notice;
events { worker_connections 256; }
http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  access_log /dev/stdout;
  sendfile on;
  server_tokens off;
  client_body_temp_path /tmp/client_body;
  proxy_temp_path /tmp/proxy;
  fastcgi_temp_path /tmp/fastcgi;
  uwsgi_temp_path /tmp/uwsgi;
  scgi_temp_path /tmp/scgi;
  server {
    listen 8080;
    root /usr/share/nginx/html;
    index index.html;
    ${securityHeaders}
    location = /health/live { default_type text/plain; return 200 'live'; }
    location = /health/ready { if (!-f /tmp/docs-config.json) { return 503; } default_type text/plain; return 200 'ready'; }
    location = /config.json {
      ${securityHeaders}
      alias /tmp/docs-config.json;
      default_type application/json;
      add_header Cache-Control 'no-store' always;
    }
    location = /index.html { ${securityHeaders} add_header Cache-Control 'no-store' always; }
    location = /assets/main.js { ${securityHeaders} add_header Cache-Control 'no-store' always; }
    location /assets/ { ${securityHeaders} add_header Cache-Control 'no-store' always; }
    location / { try_files $uri $uri/ =404; }
  }
}
`
await writeFile(join(runtimeDir, 'nginx.conf'), template.replaceAll('/tmp/', `${runtimeDir.replace(/\/$/, '')}/`), { mode: 0o444 })
