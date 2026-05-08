---
title: Cookie Policy
lastUpdated: 2026-05-08
seo: noindex
---

# Cookie Policy

**Last Updated:** May 8, 2026

This Cookie Policy explains how Tri Phung trading as WorldWideView ("we," "us," or "our") uses cookies and similar local storage technologies across our website (worldwideview.dev), Cloud Platform, and Marketplace.

## 1. What Are Cookies and Local Storage?
- **Cookies** are small text files stored on your browser. They help us remember your session, keep you logged in, and store basic preferences.
- **Local Storage (`localStorage`)** is a web technology that allows web applications to store data locally within the user's browser. We use this specifically for sensitive data that we do not want transmitted to our servers.

## 2. Essential Cookies We Use
The following cookies are strictly necessary for the operation and security of the platform:

| Cookie Name | Duration | Purpose |
|---|---|---|
| `authjs.session-token` | Session | NextAuth v5 token verifying you are logged in. |
| `authjs.csrf-token` | Session | Protects forms against Cross-Site Request Forgery attacks. |
| `authjs.callback-url` | Session | Remembers where to redirect you after a successful login. |

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
- **Optional Services**: Depending on our marketing configuration, we may utilize services like Vercel Analytics, Cloudflare Insights, or Google AdSense. These services may set their own cookies to monitor performance or serve relevant ads (to Free tier users).

## 6. How to Manage Cookies
You have the right to decide whether to accept or reject cookies. You can set or amend your web browser controls to accept or refuse cookies. If you choose to reject essential cookies (like `authjs.session-token`), you will not be able to log in to the Cloud Edition or Marketplace.

For self-hosted Local Edition users, you have full control over your environment and may block outbound analytics requests via your network firewall or ad-blocker without degrading core functionality.

## 7. Contact Us
If you have questions about our use of cookies, contact us at:
privacy@worldwideview.dev
Tri Phung trading as WorldWideView, 93A Forrest Hill Rd, Milford, Auckland, New Zealand.
