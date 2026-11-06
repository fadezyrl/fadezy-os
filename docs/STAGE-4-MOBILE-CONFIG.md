# Stage 4 — Mobile API configuration

## Single source of truth

- Public mobile config lives in `OSMobileApp/src/config/env.ts` (`mobileEnv`).
- REST URLs are built only through `OSMobileApp/src/config/api.ts` → `apiUrl()` → `services/http.ts` `apiRequest()`.
- Screens and services must not hardcode API hosts.

## Unchanged on purpose

| Setting | Value / note |
| --- | --- |
| `mobileEnv.supabaseUrl` | Existing project URL — not modified in Stage 4 |
| `mobileEnv.supabaseAnonKey` | Publishable anon key only — never service role |
| `mobileEnv.apiBaseUrl` | `http://10.0.2.2:4000` for Android emulator → host loopback |
| `mobileEnv.appRedirectUrl` | `fadezyos://auth/callback` |

## Emulator networking

Android emulator reaches the host machine at `10.0.2.2`. Physical devices need the LAN IP of the machine running the backend. Do not change this casually without coordinating client + backend env.

## What Stage 4 changed

- Removed duplicate / unused host wiring; all mobile REST calls go through `apiRequest` + `apiUrl`.
- No production endpoint or Supabase credential rotation in this stage.
