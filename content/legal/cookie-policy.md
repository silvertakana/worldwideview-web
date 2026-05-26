---
title: Cookie Policy
lastUpdated: 2026-05-27
seo: noindex
---

# Cookie Policy

**Last Updated:** May 27, 2026

This Cookie Policy explains how Tri Phung trading as WorldWideView ("we," "us," or "our") uses cookies and similar local storage technologies across our website (worldwideview.dev), Cloud Platform, and Marketplace.

## 1. What Are Cookies and Local Storage?
- **Cookies** are small text files stored on your browser. They help us remember your session, keep you logged in, and store basic preferences.
- **Local Storage (`localStorage`)** is a web technology that allows web applications to store data locally within the user's browser. We use this specifically for sensitive data that we do not want transmitted to our servers.

## 2. Essential Cookies We Use
The following cookies are strictly necessary for the operation and security of the platform:

| Cookie Name | Duration | Purpose |
|---|---|---|
| `sb-<ref>-auth-token` | Session | Supabase session token verifying you are logged in. HttpOnly, Secure, SameSite=Lax, domain `.worldwideview.dev`. |
| `sb-<ref>-auth-token.0`, `.1`, etc. | Session | Chunked session token parts (same attributes as above). Present when the session token exceeds single-cookie size limits. |

Note: `<ref>` represents the Supabase project reference identifier specific to this deployment.

## 3. Preference Cookies
These cookies enhance your experience by remembering your choices:

| Cookie Name | Duration | Purpose |
|---|---|---|
| `wwv_favorites` | 1 Year | Stores your saved entity favorites so they persist across sessions. |
| `wwv_graphics` | 1 Year | Stores your rendering and graphics quality preferences. |

## 4. Local Storage (API Keys)
To ensure your privacy and reduce our liability, we do not store your third-party API keys on our servers. They are stored solely on your device using `localStorage`:

| Key Name | Purpose |
|---|---|
| `wwv_key_google_maps` | Your personal Google Maps API key (for Photorealistic 3D Tiles). |
| `wwv_key_nasa_firms` | Your personal NASA FIRMS MAP_KEY (for wildfire plugins). |

## 5. Third-Party Analytics and Advertising
- **Umami**: We use a self-hosted instance of Umami (`analytics.worldwideview.dev`) for privacy-focused analytics. Umami does not use cookies to track users across websites and anonymizes IP addresses.
- We do not currently use advertising cookies or third-party ad networks.

## 6. How to Manage Cookies
You have the right to decide whether to accept or reject cookies. You can set or amend your web browser controls to accept or refuse cookies. If you choose to reject essential cookies (like `sb-<ref>-auth-token`), you will not be able to log in to the Cloud Edition or Marketplace.

For self-hosted Local Edition users, you have full control over your environment and may block outbound analytics requests via your network firewall or ad-blocker without degrading core functionality.

## 7. Contact Us
If you have questions about our use of cookies, contact us at:
privacy@worldwideview.dev
Tri Phung trading as WorldWideView, 93A Forrest Hill Rd, Milford, Auckland, New Zealand.
