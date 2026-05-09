# Deploy Now — 1 Minute User Action

> 5/9/2026. Panel is running locally; just need traffic routed to it.

## Current State (verified, running)



## What's still needed (1 minute, your action)

### Option A — use existing 'cloudflared-llmapi' tunnel (recommended)

1. Open https://one.dash.cloudflare.com/networks/tunnels
2. Click the tunnel currently routing  (token-managed)
3. Tab: **Public Hostname** → Add public hostname
4. Add hostname #1:
   - **Subdomain**: (leave empty)
   - **Domain**: 
   - **Path**: (leave empty)
   - **Service**:  → 
   - **Save**
5. Click **Add public hostname** again, hostname #2:
   - **Subdomain**:  (asterisk for wildcard)
   - **Domain**: 
   - **Service**:  → 
   - **Save**

After save (CF takes ~30 sec), test from anywhere:


### Option B — DNS records (if you prefer manual)

If Option A doesn't appeal, traditional CNAME approach:
1. Find your CF tunnel UUID (in CF Zero Trust → Tunnels → click tunnel → URL)
2. CF DNS → 3api.pro → add records:
   - CNAME   →  (Proxied: yes)
   - CNAME   →  (Proxied: yes — needs CF Pro)
3. (And add the routes in tunnel config OR use Zero Trust Public Hostnames as Option A)

Note: free CF tier proxies wildcard CNAMEs only on Pro plan (5/mo).
For free tier MVP, add specific subdomains as needed (no wildcard).

## After dashboard click

1. Visit https://3api.pro → see landing page
2. Visit https://demo.3api.pro/admin/login → login as admin@demo.3api.pro
3. Use admin to create end-user, issue tokens, set retail prices
4. End-customer flow: https://demo.3api.pro/signup → use API at https://demo.3api.pro/v1/messages

## Persistence note

Currently panel runs via  (development mode). For 24/7 stability:



(I can do this in a follow-up turn if you want; the tsx process is fine for verifying the tunnel routing first.)
