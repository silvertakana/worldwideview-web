---
title: Privacy Policy
lastUpdated: 2026-05-08
seo: noindex
---

# Privacy Policy

**Last Updated:** May 8, 2026

Welcome to WorldWideView. This Privacy Policy explains how Silver Takana trading as WorldWideView ("we," "us," or "our") collects, uses, shares, and protects your information when you use our website (worldwideview.dev), the WorldWideView Cloud Platform, the Local/Self-Hosted Edition, and the WorldWideView Marketplace.

## 1. Information We Collect

### A. Account & Registration Data
When you create an account for our Cloud or Marketplace services, we collect:
- Email address
- Name
- A securely hashed password (using bcrypt)
- System-assigned User ID and role

### B. Usage & Technical Data (Self-Hosted Analytics)
We use a privacy-first, self-hosted analytics tool (Umami) to understand how our platform is used. This data never leaves our servers and is not shared with third-party advertisers. We collect:
- Page views and browser metadata (e.g., screen size, OS)
- Custom interaction events (e.g., layer toggles, camera moves, plugin installs)
- Event metadata (e.g., plugin IDs, setting keys), which does not contain personally identifiable information (PII)

### C. Error Tracking
To improve stability, we collect error stack traces and crash reports using a self-hosted instance of GlitchTip. This data includes technical diagnostics but is stripped of PII where possible.

### D. User Preferences (Stored Locally)
Certain preferences are stored directly on your device:
- **API Keys**: Keys you provide for third-party services (like Google Maps or NASA FIRMS) are saved in your browser's `localStorage`. We do not transmit these keys to our servers.
- **Favorites & Settings**: Saved views, UI configurations, and graphics settings are stored in cookies (`wwv_favorites`, `wwv_graphics`) to persist across sessions.

## 2. How We Use Your Information

We use the information we collect to:
- Provide, maintain, and improve the WorldWideView platform.
- Authenticate your access to the Cloud Edition and Marketplace.
- Process transactions and send related information, including confirmations and invoices.
- Monitor and analyze trends, usage, and activities.
- Detect, investigate, and prevent technical issues and security incidents.
- Send you technical notices, updates, security alerts, and administrative messages.
- Send you marketing communications, *only if you have explicitly opted in*.

## 3. How We Share Your Information

We do not sell your personal data. We only share information with trusted third-party services necessary to operate our platform:

| Service | What Is Shared | Purpose |
|---|---|---|
| **Stripe** | Email, payment details | Payment processing for Cloud subscriptions |
| **Cesium Ion** | Our API token, map tile requests | Rendering the 3D globe |
| **Google Maps** / **Bing Maps** | Your API key (direct from browser), tile requests | Retrieving satellite imagery and 3D tiles |
| **NASA FIRMS** | Your API key (direct from browser) | Retrieving wildfire data |
| **OpenSky Network** / **AIS Stream** | Server-side connections only | Fetching real-time aviation and maritime data |

## 4. Data Storage, Security, and Residency

- **Data Residency**: All user account data for the Cloud Edition and Marketplace is stored securely in databases located in **New Zealand**.
- **Security**: Passwords are cryptographically hashed using bcrypt. Active sessions are managed via secure JWT tokens. 
- **Local Edition**: If you use the self-hosted Local Edition, your configurations and saved data reside entirely in your local SQLite database on your own hardware.

## 5. Cookies and Tracking

We use standard session and security cookies for authentication (e.g., `authjs.session-token`, `authjs.csrf-token`). For a complete list of cookies and local storage keys, please read our [Cookie Policy](/legal/cookies).

## 6. Your Data Rights

Depending on your location, you may have specific rights regarding your personal data:
- **GDPR (EU/EEA)**: Right to access, rectify, erase, restrict processing, and data portability.
- **CCPA (California)**: Right to know what data is collected, delete data, and opt-out of the sale of data (Note: We do not sell data).
- **New Zealand Privacy Act 2020**: Right to access and correct personal information.

To exercise these rights, contact us at privacy@worldwideview.dev.

## 7. Data Retention

We retain your account data for as long as your account is active. If you delete your account, we will purge your personal data within 30 days. Analytics data is anonymized and retained indefinitely to help us measure long-term platform health.

## 8. Children's Privacy

WorldWideView is not directed to children. You must be at least 13 years old to use the platform (or 16 years old if you reside in the EU/EEA, pursuant to GDPR Article 8). If we learn we have collected personal data from a child under the applicable age threshold, we will delete it.

## 9. Communications

If you have opted in, we may send you product updates and promotional content. Every marketing email includes a mandatory unsubscribe link. 

## 10. Changes to This Policy

We may update this Privacy Policy from time to time. We will notify you of material changes via email or an in-app notification.

## 11. Contact Us

If you have any questions about this Privacy Policy, please contact us:
- **Email**: privacy@worldwideview.dev
- **Address**: Silver Takana trading as WorldWideView, 93A Forrest Hill Rd, Milford, Auckland, New Zealand
